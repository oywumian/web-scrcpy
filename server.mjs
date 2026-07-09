import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
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

const mimeTypes = {
  '.bin': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const wsClients = new Set()
const adbClient = new AdbServerClient(
  new AdbServerNodeTcpConnector({
    host: '127.0.0.1',
    port: 5037,
  }),
)

let activeSession

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
  for (const ws of wsClients) {
    sendJson(ws, payload)
  }
}

function pushLog(line) {
  const stamped = `[server] ${line}`
  console.log(stamped)
  broadcastJson({ type: 'log', line: stamped })
}

function runProcess(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(file, args, {
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

      rejectPromise(
        new Error(`${file} ${args.join(' ')} failed with exit code ${code}: ${stderr.trim()}`),
      )
    })
  })
}

async function ensureAdbServer() {
  if (!existsSync(adbPath)) {
    throw new Error('缺少 platform-tools/adb.exe。')
  }

  await runProcess(adbPath, ['start-server'])
}

async function loadScrcpyServerStream() {
  const data = await readFile(scrcpyServerPath)

  return new PushReadableStream(async (controller) => {
    await controller.enqueue(new Uint8Array(data))
    controller.close()
  })
}

async function listDevices() {
  await ensureAdbServer()

  const devices = await adbClient.getDevices(['device', 'offline', 'unauthorized'])

  return devices.map((device) => ({
    serial: device.serial,
    model: device.model || device.product || device.device || device.serial,
    state: device.state,
  }))
}

async function stopSession(reason = '镜像已停止。') {
  const session = activeSession
  if (!session) {
    return
  }

  activeSession = undefined
  session.state = 'idle'

  try {
    session.videoReader?.cancel()
  } catch {
    // Ignore canceled streams during shutdown.
  }

  try {
    session.outputReader?.cancel()
  } catch {
    // Ignore canceled streams during shutdown.
  }

  try {
    await session.client.close()
  } catch {
    // Ignore client shutdown races.
  }

  try {
    await session.adb.close()
  } catch {
    // Ignore ADB shutdown races.
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

async function startSession(serial) {
  if (activeSession?.serial === serial && activeSession.state === 'connected') {
    broadcastJson({ type: 'session', session: serializeSession() })
    return
  }

  await stopSession('正在切换到新的镜像会话。')
  await ensureAdbServer()

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
    maxSize: 1600,
    powerOn: true,
    video: true,
    videoBitRate: 8_000_000,
    videoCodec: 'h264',
  })

  const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
  const video = await client.videoStream
  if (!video) {
    throw new Error('scrcpy 没有返回视频流。')
  }

  activeSession = {
    adb,
    client,
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
    lastConfigurationPacket: null,
  }

  pushLog(`已启动镜像：${name}（${serial}）。`)
  broadcastJson({ type: 'session', session: serializeSession() })

  activeSession.outputReader = client.output.getReader()
  activeSession.videoReader = video.stream.getReader()

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
        pushLog(`日志流结束：${error instanceof Error ? error.message : String(error)}`)
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

        broadcastJson({
          type: 'video',
          packet: {
            kind: value.type,
            data: Buffer.from(value.data).toString('base64'),
            keyframe: value.type === 'data' ? value.keyframe : undefined,
            pts: value.type === 'data' && value.pts !== undefined ? value.pts.toString() : undefined,
          },
        })
      }
    } catch (error) {
      if (activeSession === session) {
        pushLog(`视频流结束：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (activeSession === session) {
      await stopSession('镜像会话已结束。')
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
        sendJson(ws, { type: 'error', message: '请先选择设备序列号。' })
        return
      }

      broadcastJson({
        type: 'session',
        session: {
          state: 'connecting',
          serial: payload.serial,
        },
      })

      await startSession(payload.serial)
      await broadcastDevices()
      return
    case 'disconnect-device':
      await stopSession('镜像已被页面访问者停止。')
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
          await activeSession.client.controller.setScreenPowerMode(AndroidScreenPowerMode.Off)
          return
        case 'screen-on':
          await activeSession.client.controller.setScreenPowerMode(AndroidScreenPowerMode.Normal)
          return
        default:
          sendJson(ws, { type: 'error', message: `未知命令：${payload.command}` })
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
      sendJson(ws, { type: 'error', message: `未知消息类型：${payload.type}` })
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

wss.on('connection', async (ws) => {
  wsClients.add(ws)
  sendJson(ws, { type: 'hello', session: serializeSession() })
  await broadcastDevices(ws)

  if (activeSession?.lastConfigurationPacket) {
    sendJson(ws, {
      type: 'video',
      packet: {
        kind: 'configuration',
        data: Buffer.from(activeSession.lastConfigurationPacket.data).toString('base64'),
      },
    })

    void activeSession.client.controller?.resetVideo()
  }

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
    wsClients.delete(ws)
  })
})

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url ?? '/', `http://${host}:${port}`)
  if (requestUrl.pathname !== '/ws') {
    socket.destroy()
    return
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})

server.listen(port, host, async () => {
  try {
    await ensureAdbServer()
    pushLog('ADB 服务已就绪。')
  } catch (error) {
    pushLog(`ADB 启动失败：${error instanceof Error ? error.message : String(error)}`)
  }

  console.log(`共享版 Web Scrcpy 已启动：http://${host}:${port}`)
})
