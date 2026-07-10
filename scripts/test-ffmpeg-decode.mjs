import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import { DefaultServerPath } from '@yume-chan/scrcpy'
import { PushReadableStream } from '@yume-chan/stream-extra'
import ffmpegPath from 'ffmpeg-static'

const serial = process.argv[2] ?? 'QV7201A354'
const scrcpyServerPath = resolve('node_modules/@yume-chan/fetch-scrcpy-server/server.bin')

const adbClient = new AdbServerClient(
  new AdbServerNodeTcpConnector({
    host: '127.0.0.1',
    port: 5037,
  }),
)

async function loadScrcpyServerStream() {
  const data = await readFile(scrcpyServerPath)

  return new PushReadableStream(async (controller) => {
    await controller.enqueue(new Uint8Array(data))
    controller.close()
  })
}

const adb = await adbClient.createAdb({ serial })
await AdbScrcpyClient.pushServer(adb, await loadScrcpyServerStream(), DefaultServerPath)

const options = new AdbScrcpyOptionsLatest({
  audio: false,
  cleanup: true,
  control: false,
  logLevel: 'info',
  maxFps: 60,
  maxSize: 1600,
  powerOn: true,
  video: true,
  videoBitRate: 12_000_000,
  videoCodec: 'h264',
})

const client = await AdbScrcpyClient.start(adb, DefaultServerPath, options)
const video = await client.videoStream
if (!video) {
  throw new Error('No video stream')
}

const width = video.metadata.width
const height = video.metadata.height
const frameSize = Math.floor(width * height * 1.5)

const ffmpeg = spawn(
  ffmpegPath,
  [
    '-loglevel',
    'info',
    '-f',
    'h264',
    '-i',
    'pipe:0',
    '-pix_fmt',
    'yuv420p',
    '-f',
    'rawvideo',
    'pipe:1',
  ],
  {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  },
)

let stdoutBytes = 0
ffmpeg.stdout.on('data', (chunk) => {
  stdoutBytes += chunk.length
  console.log(`stdout chunk=${chunk.length} total=${stdoutBytes} frameSize=${frameSize}`)
})

ffmpeg.stderr.on('data', (chunk) => {
  process.stdout.write(chunk)
})

const reader = video.stream.getReader()
for (let index = 0; index < 40; index += 1) {
  const { done, value } = await reader.read()
  if (done) {
    break
  }

  ffmpeg.stdin.write(value.data)
}

ffmpeg.stdin.end()

await new Promise((resolvePromise) => {
  ffmpeg.on('close', resolvePromise)
})

await reader.cancel()
await client.close()
await adb.close()
