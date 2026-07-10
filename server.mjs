import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import {
  AndroidKeyCode,
  AndroidKeyEventAction,
  AndroidKeyEventMeta,
  AndroidMotionEventAction,
  AndroidMotionEventButton,
  AndroidScreenPowerMode,
  DefaultServerPath,
  ScrcpyPointerId,
} from '@yume-chan/scrcpy'
import { PushReadableStream } from '@yume-chan/stream-extra'
import WebSocket, { WebSocketServer } from 'ws'

const env =
  typeof process !== 'undefined' && process?.env
    ? process.env
    : (globalThis.__webScrcpyEnv ?? {})

const host = env.HOST ?? '0.0.0.0'
const port = Number(env.PORT ?? 4173)
const root = resolve('dist')
const adbPath = resolve('platform-tools/adb.exe')
const scrcpyServerPath = resolve('node_modules/@yume-chan/fetch-scrcpy-server/server.bin')

const DEFAULT_VIDEO_BIT_RATE = 6_000_000
const DEFAULT_MAX_FPS = 30
const MIN_VIDEO_BIT_RATE = 1_000_000
const MAX_VIDEO_BIT_RATE = 20_000_000
const MIN_MAX_FPS = 15
const MAX_MAX_FPS = 60
const SCREEN_OFF_GUARD_INTERVAL_MS = 60_000

const VIDEO_PACKET_CONFIGURATION = 0
const VIDEO_PACKET_KEYFRAME = 1
const VIDEO_PACKET_DELTA = 2

const mimeTypes = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const controlClients = new Map()
const videoClients = new Map()
const adbClient = new AdbServerClient(
  new AdbServerNodeTcpConnector({
    host: '127.0.0.1',
    port: 5037,
  }),
)

let activeSession

function getClientId(requestUrl) {
  return requestUrl.searchParams.get('clientId') || 'default-client'
}

function closeSocket(ws, code = 4000, reason = 'Another controller has taken over.') {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    return
  }

  try {
    ws.close(code, reason)
  } catch {}
}

function closeClientPair(clientId, reason) {
  const controlWs = controlClients.get(clientId)
  const videoWs = videoClients.get(clientId)

  closeSocket(controlWs, 4000, reason)
  closeSocket(videoWs, 4000, reason)

  controlClients.delete(clientId)
  videoClients.delete(clientId)
}

function evictOtherClients(activeClientId) {
  for (const clientId of controlClients.keys()) {
    if (clientId !== activeClientId) {
      closeClientPair(clientId, 'Another controller page has connected.')
    }
  }

  for (const clientId of videoClients.keys()) {
    if (clientId !== activeClientId) {
      closeClientPair(clientId, 'Another controller page has connected.')
    }
  }
}

function clampNumber(value, minimum, maximum, fallback) {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function normalizeSessionConfig(payload = {}) {
  return {
    screenOff: Boolean(payload.screenOff),
    videoBitRate: clampNumber(
      Number(payload.videoBitRate),
      MIN_VIDEO_BIT_RATE,
      MAX_VIDEO_BIT_RATE,
      DEFAULT_VIDEO_BIT_RATE,
    ),
    maxFps: clampNumber(Number(payload.maxFps), MIN_MAX_FPS, MAX_MAX_FPS, DEFAULT_MAX_FPS),
  }
}

function isSameSessionConfig(left, right) {
  return (
    left.videoBitRate === right.videoBitRate &&
    left.maxFps === right.maxFps &&
    left.screenOff === right.screenOff
  )
}

function serializeSession() {
  if (!activeSession) {
    return { state: 'idle' }
  }

  return {
    state: activeSession.state,
    serial: activeSession.serial,
    name: activeSession.name,
    codec: activeSession.videoMetadata.codec,
    width: activeSession.videoMetadata.width,
    height: activeSession.videoMetadata.height,
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function broadcastJson(payload) {
  for (const ws of controlClients.values()) {
    sendJson(ws, payload)
  }
}

function pushLog(line) {
  const stamped = `[server] ${line}`
  console.log(stamped)
  broadcastJson({ type: 'log', line: stamped })
}

async function setDeviceScreenPower(controller, mode) {
  if (!controller) {
    return
  }

  if (mode === AndroidScreenPowerMode.Off) {
    pushLog('Sending screen-off command to device.')
  } else {
    pushLog('Sending screen-on command to device.')
  }

  await controller.setScreenPowerMode(mode)

  if (mode === AndroidScreenPowerMode.Off) {
    pushLog('Screen-off command sent.')
  } else {
    pushLog('Screen-on command sent.')
  }
}

async function runAdbStartServer() {
  const { spawn } = await import('node:child_process')

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(adbPath, ['start-server'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
        return
      }

      rejectPromise(new Error(`adb start-server failed with exit code ${code}: ${stderr.trim()}`))
    })
  })
}

async function runAdbCommand(args) {
  const { spawn } = await import('node:child_process')

  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(adbPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', rejectPromise)
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr })
        return
      }

      rejectPromise(new Error(`adb ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`))
    })
  })
}

async function readDeviceScreenPowerState(serial) {
  const { stdout } = await runAdbCommand(['-s', serial, 'shell', 'dumpsys', 'power'])
  const normalized = stdout.replace(/\r/g, '')

  if (/Display Power: state=OFF/i.test(normalized)) {
    return 'off'
  }

  if (/Display Power: state=ON/i.test(normalized)) {
    return 'on'
  }

  if (/mWakefulness=(Asleep|Dozing)/i.test(normalized)) {
    return 'off'
  }

  if (/mWakefulness=Awake/i.test(normalized)) {
    return 'on'
  }

  return 'unknown'
}

function startScreenOffGuard(session) {
  if (!session?.config.screenOff) {
    return
  }

  session.screenPowerGuardTimer = setInterval(async () => {
    if (activeSession !== session || session.screenPowerGuardInFlight) {
      return
    }

    session.screenPowerGuardInFlight = true

    try {
      const state = await readDeviceScreenPowerState(session.serial)
      if (activeSession !== session) {
        return
      }

      if (state === 'on') {
        pushLog('Screen-off guard detected the device screen is on. Turning it off again.')
        await setDeviceScreenPower(session.client.controller, AndroidScreenPowerMode.Off)
      }
    } catch (error) {
      if (activeSession === session) {
        pushLog(`Screen-off guard check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      session.screenPowerGuardInFlight = false
    }
  }, SCREEN_OFF_GUARD_INTERVAL_MS)
}

async function ensureAdbServerReady() {
  if (!existsSync(adbPath)) {
    throw new Error('Missing platform-tools/adb.exe')
  }

  await runAdbStartServer()
}

async function loadScrcpyServerStream() {
  const data = await readFile(scrcpyServerPath)

  return new PushReadableStream(async (controller) => {
    await controller.enqueue(new Uint8Array(data))
    controller.close()
  })
}

async function listDevices() {
  await ensureAdbServerReady()

  const devices = await adbClient.getDevices(['device', 'offline', 'unauthorized'])

  return devices.map((device) => ({
    serial: device.serial,
    model: device.model || device.product || device.device || device.serial,
    state: device.state,
  }))
}

function encodeVideoPacket(packet) {
  const type =
    packet.type === 'configuration'
      ? VIDEO_PACKET_CONFIGURATION
      : packet.keyframe
        ? VIDEO_PACKET_KEYFRAME
        : VIDEO_PACKET_DELTA
  const payload = Buffer.from(packet.data)
  const header = Buffer.allocUnsafe(5)

  header.writeUInt8(type, 0)
  header.writeUInt32BE(payload.length, 1)

  return Buffer.concat([header, payload])
}

function broadcastVideoPacket(packet) {
  if (videoClients.size === 0) {
    return
  }

  const encoded = encodeVideoPacket(packet)
  for (const ws of videoClients.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encoded)
    }
  }
}

async function stopSession(reason = 'Mirror session stopped.') {
  const session = activeSession
  if (!session) {
    return
  }

  activeSession = undefined
  session.state = 'idle'

  try {
    session.videoReader?.cancel()
  } catch {}

  try {
    session.outputReader?.cancel()
  } catch {}

  try {
    await session.client.close()
  } catch {}

  try {
    await session.adb.close()
  } catch {}

  if (session.screenPowerGuardTimer) {
    clearInterval(session.screenPowerGuardTimer)
    session.screenPowerGuardTimer = undefined
  }

  pushLog(reason)
  broadcastJson({ type: 'session', session: serializeSession() })
}

async function broadcastDevices(targetWs) {
  try {
    const devices = await listDevices()
    const payload = { type: 'devices', devices }
    if (targetWs) {
      sendJson(targetWs, payload)
    } else {
      broadcastJson(payload)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (targetWs) {
      sendJson(targetWs, { type: 'error', message })
    } else {
      broadcastJson({ type: 'error', message })
    }
  }
}

async function startSession(serial, rawConfig = {}) {
  const config = normalizeSessionConfig(rawConfig)

  if (
    activeSession?.serial === serial &&
    activeSession.state === 'connected' &&
    isSameSessionConfig(activeSession.config, config)
  ) {
    broadcastJson({ type: 'session', session: serializeSession() })
    return
  }

  await stopSession('Switching to a new device session.')
  await ensureAdbServerReady()

  const adb = await adbClient.createAdb({ serial })
  const name =
    (await adb.getProp('ro.product.model').catch(() => '')) ||
    (await adb.getProp('ro.product.name').catch(() => '')) ||
    serial

  await AdbScrcpyClient.pushServer(adb, await loadScrcpyServerStream(), DefaultServerPath)

  const options = new AdbScrcpyOptionsLatest({
    audio: false,
    cleanup: true,
    control: true,
    logLevel: 'info',
    maxFps: config.maxFps,
    maxSize: 1280,
    powerOn: true,
    video: true,
    videoBitRate: config.videoBitRate,
    videoCodec: 'h264',
  })

  const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
  const video = await client.videoStream
  if (!video) {
    throw new Error('scrcpy did not return a video stream')
  }

  activeSession = {
    adb,
    client,
    config,
    lastConfigurationPacket: null,
    name,
    outputReader: null,
    serial,
    state: 'connected',
    videoMetadata: {
      codec: video.metadata.codec,
      height: video.height || video.metadata.height || 1920,
      width: video.width || video.metadata.width || 1080,
    },
    videoReader: null,
  }

  pushLog(
    `Started mirror: ${name} (${serial}), ${(config.videoBitRate / 1_000_000).toFixed(0)} Mbps, ${config.maxFps} FPS.`,
  )
  broadcastJson({ type: 'session', session: serializeSession() })

  activeSession.outputReader = client.output.getReader()
  activeSession.videoReader = video.stream.getReader()
  activeSession.screenPowerGuardInFlight = false

  if (config.screenOff) {
    const session = activeSession
    void (async () => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 800))
      if (activeSession !== session) {
        return
      }

      await setDeviceScreenPower(session.client.controller, AndroidScreenPowerMode.Off)
      pushLog('Screen-off mode enabled for this session.')
      startScreenOffGuard(session)
    })()
  }

  void (async () => {
    const session = activeSession
    if (!session) {
      return
    }

    try {
      while (activeSession === session) {
        const { done, value } = await session.outputReader.read()
        if (done) {
          break
        }

        const line = value.trim()
        if (line) {
          pushLog(line)
        }
      }
    } catch (error) {
      if (activeSession === session) {
        pushLog(`Output stream ended: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })()

  void (async () => {
    const session = activeSession
    if (!session) {
      return
    }

    try {
      while (activeSession === session) {
        const { done, value } = await session.videoReader.read()
        if (done) {
          break
        }

        if (value.type === 'configuration') {
          session.lastConfigurationPacket = value
        }

        broadcastVideoPacket(value)
      }
    } catch (error) {
      if (activeSession === session) {
        pushLog(`Video stream ended: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (activeSession === session) {
      await stopSession('Mirror session ended.')
    }
  })()
}

async function handleClientMessage(ws, rawMessage) {
  const payload = JSON.parse(rawMessage.toString())

  switch (payload.type) {
    case 'refresh-devices':
      await broadcastDevices(ws)
      return
    case 'connect-device':
      if (!payload.serial) {
        sendJson(ws, { type: 'error', message: 'Please select a device first.' })
        return
      }

      broadcastJson({
        type: 'session',
        session: {
          state: 'connecting',
          serial: payload.serial,
        },
      })

      await startSession(payload.serial, payload)
      await broadcastDevices()
      return
    case 'disconnect-device':
      await stopSession('Mirror session stopped from the page.')
      await broadcastDevices()
      return
    case 'send-text':
      await activeSession?.client.controller?.injectText(payload.text || '')
      return
    case 'command':
      if (!activeSession?.client.controller) {
        return
      }

      switch (payload.command) {
        case 'back':
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Down,
            keyCode: AndroidKeyCode.AndroidBack,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Up,
            keyCode: AndroidKeyCode.AndroidBack,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          return
        case 'home':
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Down,
            keyCode: AndroidKeyCode.AndroidHome,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Up,
            keyCode: AndroidKeyCode.AndroidHome,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          return
        case 'app-switch':
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Down,
            keyCode: AndroidKeyCode.AndroidAppSwitch,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          await activeSession.client.controller.injectKeyCode({
            action: AndroidKeyEventAction.Up,
            keyCode: AndroidKeyCode.AndroidAppSwitch,
            metaState: AndroidKeyEventMeta.None,
            repeat: 0,
          })
          return
        case 'rotate':
          await activeSession.client.controller.rotateDevice()
          return
        case 'screen-off':
          await setDeviceScreenPower(activeSession.client.controller, AndroidScreenPowerMode.Off)
          return
        case 'screen-on':
          await setDeviceScreenPower(activeSession.client.controller, AndroidScreenPowerMode.Normal)
          return
        default:
          sendJson(ws, { type: 'error', message: `Unknown command: ${payload.command}` })
      }
      return
    case 'touch':
      if (!activeSession?.client.controller) {
        return
      }

      await activeSession.client.controller.injectTouch({
        action: payload.action,
        pointerId: ScrcpyPointerId.Mouse,
        pointerX: payload.pointerX,
        pointerY: payload.pointerY,
        videoWidth: payload.videoWidth,
        videoHeight: payload.videoHeight,
        pressure: payload.action === AndroidMotionEventAction.Up ? 0 : 1,
        actionButton: AndroidMotionEventButton.Primary,
        buttons:
          payload.action === AndroidMotionEventAction.Up
            ? AndroidMotionEventButton.None
            : AndroidMotionEventButton.Primary,
      })
      return
    default:
      sendJson(ws, { type: 'error', message: `Unknown message type: ${payload.type}` })
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`)

    if (requestUrl.pathname === '/api/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, session: serializeSession() }))
      return
    }

    let relativePath =
      requestUrl.pathname === '/' ? 'index.html' : normalize(requestUrl.pathname).replace(/^([/\\])+/, '')
    let filePath = join(root, relativePath)

    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('Forbidden')
      return
    }

    if (!existsSync(filePath)) {
      filePath = join(root, 'index.html')
    } else {
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    })
    createReadStream(filePath).pipe(response)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(error instanceof Error ? error.message : String(error))
  }
})

const wss = new WebSocketServer({ noServer: true })
const videoWss = new WebSocketServer({ noServer: true })

wss.on('connection', async (ws, request) => {
  const requestUrl = new URL(request.url ?? '/ws', `http://${host}:${port}`)
  const clientId = getClientId(requestUrl)

  evictOtherClients(clientId)
  closeSocket(controlClients.get(clientId), 4001, 'Controller page reconnected.')
  controlClients.set(clientId, ws)

  sendJson(ws, { type: 'hello', session: serializeSession() })
  await broadcastDevices(ws)

  ws.on('message', async (message) => {
    try {
      await handleClientMessage(ws, message)
    } catch (error) {
      sendJson(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })

  ws.on('close', () => {
    if (controlClients.get(clientId) === ws) {
      controlClients.delete(clientId)
    }
  })
})

videoWss.on('connection', (ws, request) => {
  const requestUrl = new URL(request.url ?? '/video', `http://${host}:${port}`)
  const clientId = getClientId(requestUrl)

  evictOtherClients(clientId)
  closeSocket(videoClients.get(clientId), 4001, 'Video page reconnected.')
  videoClients.set(clientId, ws)

  if (activeSession?.lastConfigurationPacket) {
    ws.send(encodeVideoPacket(activeSession.lastConfigurationPacket))
  }

  ws.on('close', () => {
    if (videoClients.get(clientId) === ws) {
      videoClients.delete(clientId)
    }
  })
})

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`)

  if (requestUrl.pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
    return
  }

  if (requestUrl.pathname === '/video') {
    videoWss.handleUpgrade(request, socket, head, (ws) => {
      videoWss.emit('connection', ws, request)
    })
    return
  }

  socket.destroy()
})

server.listen(port, host, async () => {
  try {
    await ensureAdbServerReady()
    pushLog('ADB server ready.')
  } catch (error) {
    pushLog(`ADB startup failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`Web Scrcpy server started: http://${host}:${port}`)
})
