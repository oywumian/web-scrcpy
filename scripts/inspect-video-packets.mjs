import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { AdbServerClient } from '@yume-chan/adb'
import { AdbScrcpyClient, AdbScrcpyOptionsLatest } from '@yume-chan/adb-scrcpy'
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp'
import { DefaultServerPath } from '@yume-chan/scrcpy'
import { PushReadableStream } from '@yume-chan/stream-extra'

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

function hexHead(data, size = 24) {
  return Array.from(data.subarray(0, size))
    .map((item) => item.toString(16).padStart(2, '0'))
    .join(' ')
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

console.log(
  JSON.stringify(
    {
      serial,
      width: video.width,
      height: video.height,
      metadata: video.metadata,
    },
    null,
    2,
  ),
)

const reader = video.stream.getReader()
for (let index = 0; index < 8; index += 1) {
  const { done, value } = await reader.read()
  if (done) {
    break
  }

  console.log(
    JSON.stringify(
      {
        index,
        type: value.type,
        keyframe: value.keyframe ?? null,
        pts: typeof value.pts === 'bigint' ? value.pts.toString() : (value.pts ?? null),
        size: value.data.length,
        head: hexHead(value.data),
      },
      null,
      2,
    ),
  )
}

await reader.cancel()
await client.close()
await adb.close()
