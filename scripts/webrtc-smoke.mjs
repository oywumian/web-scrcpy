import WebSocket from 'ws'
import wrtcModule from '@roamhq/wrtc'

const {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  nonstandard: { RTCVideoSink },
} = wrtcModule

const serverUrl = process.argv[2] ?? 'ws://127.0.0.1:4173/ws'
const targetSerial = process.argv[3] ?? ''
const timeoutMs = 30000

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
}

function sendJson(ws, payload) {
  ws.send(JSON.stringify(payload))
}

async function main() {
  const ws = new WebSocket(serverUrl)
  const peer = new RTCPeerConnection({ iceServers: [] })

  let selectedSerial = targetSerial
  let gotTrack = false
  let gotFrame = false
  let frameCount = 0
  let sessionConnected = false

  const failTimer = setTimeout(() => {
    console.error(
      JSON.stringify({
        ok: false,
        phase: gotFrame ? 'done' : gotTrack ? 'frame-timeout' : sessionConnected ? 'track-timeout' : 'session-timeout',
        selectedSerial,
        frameCount,
      }),
    )
    cleanup(1)
  }, timeoutMs)

  function cleanup(code = 0) {
    clearTimeout(failTimer)
    try {
      peer.close()
    } catch {}
    try {
      ws.close()
    } catch {}
    setTimeout(() => process.exit(code), 100)
  }

  peer.addTransceiver('video', { direction: 'recvonly' })

  peer.onicecandidate = ({ candidate }) => {
    if (candidate) {
      sendJson(ws, { type: 'webrtc-ice-candidate', candidate: candidate.toJSON() })
    }
  }

  peer.ontrack = ({ track }) => {
    gotTrack = true
    const sink = new RTCVideoSink(track)
    sink.addEventListener('frame', () => {
      frameCount += 1
      gotFrame = true
      if (frameCount >= 3) {
        console.log(JSON.stringify({ ok: true, selectedSerial, frameCount }))
        sink.stop()
        cleanup(0)
      }
    })
  }

  ws.on('message', async (raw) => {
    const message = JSON.parse(raw.toString())

    if (message.type === 'devices' && !selectedSerial) {
      selectedSerial = message.devices.find((item) => item.state === 'device')?.serial ?? ''
      if (!selectedSerial) {
        return
      }

      sendJson(ws, {
        type: 'connect-device',
        serial: selectedSerial,
        videoBitRate: 12_000_000,
        maxFps: 60,
      })
      return
    }

    if (message.type === 'session' && message.session?.state === 'connected' && message.session?.serial) {
      sessionConnected = true
      if (!selectedSerial) {
        selectedSerial = message.session.serial
      }

      if (!peer.localDescription) {
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        sendJson(ws, { type: 'webrtc-offer', sdp: offer.sdp })
      }
      return
    }

    if (message.type === 'webrtc-answer' && message.sdp) {
      await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: message.sdp }))
      return
    }

    if (message.type === 'webrtc-ice-candidate' && message.candidate) {
      await peer.addIceCandidate(new RTCIceCandidate(message.candidate))
      return
    }

    if (message.type === 'error') {
      console.error(JSON.stringify({ ok: false, phase: 'server-error', message: message.message }))
      cleanup(1)
    }
  })

  await waitForOpen(ws)
  sendJson(ws, { type: 'refresh-devices' })

  if (selectedSerial) {
    sendJson(ws, {
      type: 'connect-device',
      serial: selectedSerial,
      videoBitRate: 12_000_000,
      maxFps: 60,
    })
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, phase: 'crash', message: error instanceof Error ? error.message : String(error) }))
  process.exit(1)
})
