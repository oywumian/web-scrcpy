import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { WebCodecsVideoDecoder } from '@yume-chan/scrcpy-decoder-webcodecs'
import { AndroidMotionEventAction, type ScrcpyMediaStreamPacket, type ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
import './App.css'

type MirrorState = 'idle' | 'connecting' | 'connected' | 'error'
type DeviceState = 'device' | 'offline' | 'unauthorized'

type DeviceInfo = {
  serial: string
  model?: string
  state: DeviceState
}

type SessionInfo = {
  state: MirrorState
  serial?: string
  name?: string
  codec?: ScrcpyVideoCodecId
  width?: number
  height?: number
}

type ServerMessage =
  | { type: 'devices'; devices: DeviceInfo[] }
  | { type: 'error'; message: string }
  | { type: 'hello'; session: SessionInfo }
  | { type: 'log'; line: string }
  | { type: 'session'; session: SessionInfo }

const MAX_LOG_LINES = 150
const DEVICE_REFRESH_MS = 5000
const FPS_SAMPLE_MS = 5000
const TARGET_FPS = 30
const CAPTURE_BIT_RATE = 6

const VIDEO_PACKET_CONFIGURATION = 0
const VIDEO_PACKET_KEYFRAME = 1

const DEVICE_STATE_LABEL: Record<DeviceState, string> = {
  device: 'Ready',
  offline: 'Offline',
  unauthorized: 'Locked',
}

class Canvas2dVideoFrameRenderer {
  canvas: HTMLCanvasElement
  #context: CanvasRenderingContext2D

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
    })
    if (!context) {
      throw new Error('2D canvas renderer is unavailable')
    }

    this.#context = context
  }

  setSize(width: number, height: number) {
    if (this.canvas.width !== width) {
      this.canvas.width = width
    }
    if (this.canvas.height !== height) {
      this.canvas.height = height
    }
  }

  async draw(frame: VideoFrame) {
    this.#context.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height)
  }
}

function parseVideoPacket(data: ArrayBuffer): ScrcpyMediaStreamPacket | null {
  const view = new DataView(data)
  if (view.byteLength < 5) {
    return null
  }

  const type = view.getUint8(0)
  const payloadLength = view.getUint32(1)
  if (payloadLength !== view.byteLength - 5) {
    return null
  }

  const payload = new Uint8Array(data, 5)
  if (type === VIDEO_PACKET_CONFIGURATION) {
    return { type: 'configuration', data: payload }
  }

  return {
    type: 'data',
    keyframe: type === VIDEO_PACKET_KEYFRAME,
    data: payload,
  }
}

function App() {
  const [devices, setDevices] = useState<DeviceInfo[]>([])
  const [selectedSerial, setSelectedSerial] = useState('')
  const [session, setSession] = useState<SessionInfo>({ state: 'idle' })
  const [screenSize, setScreenSize] = useState({ width: 1080, height: 1920 })
  const [estimatedFps, setEstimatedFps] = useState(0)
  const [typedText, setTypedText] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [socketReady, setSocketReady] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [decoderSupported, setDecoderSupported] = useState(true)
  const [showLogs, setShowLogs] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const videoSocketRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null)
  const decoderWriterRef = useRef<WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null>(null)
  const screenSizeRef = useRef({ width: 1080, height: 1920 })
  const pointerDownRef = useRef(false)
  const frameCountRef = useRef(0)

  const appendLog = useCallback((line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    setLogLines((current) => [...current.slice(-MAX_LOG_LINES + 1), stamped])
  }, [])

  const resetDecoder = useCallback(() => {
    decoderWriterRef.current?.releaseLock()
    decoderWriterRef.current = null
    decoderRef.current?.dispose()
    decoderRef.current = null
    frameCountRef.current = 0
    setEstimatedFps(0)

    const canvas = canvasRef.current
    if (canvas) {
      const context = canvas.getContext('2d')
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
  }, [])

  const ensureDecoder = useCallback(
    (nextSession: SessionInfo) => {
      const canvas = canvasRef.current
      if (!canvas || !nextSession.codec) {
        return
      }

      if (!WebCodecsVideoDecoder.isSupported) {
        setDecoderSupported(false)
        return
      }

      const existing = decoderRef.current
      if (existing && existing.codec === nextSession.codec) {
        return
      }

      resetDecoder()

      const renderer = new Canvas2dVideoFrameRenderer(canvas)
      const decoder = new WebCodecsVideoDecoder({
        codec: nextSession.codec,
        renderer,
      })

      decoder.sizeChanged(({ width, height }) => {
        screenSizeRef.current = { width, height }
        setScreenSize({ width, height })
      })

      decoderRef.current = decoder
      decoderWriterRef.current = decoder.writable.getWriter()
      setDecoderSupported(true)
    },
    [resetDecoder],
  )

  const sendMessage = useCallback(
    (payload: object) => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        appendLog('Control link is not ready yet.')
        return false
      }

      socket.send(JSON.stringify(payload))
      return true
    },
    [appendLog],
  )

  useEffect(() => {
    return () => {
      resetDecoder()
      socketRef.current?.close()
      videoSocketRef.current?.close()
    }
  }, [resetDecoder])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'

    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`)
    socketRef.current = socket

    socket.addEventListener('open', () => {
      setSocketReady(true)
      socket.send(JSON.stringify({ type: 'refresh-devices' }))
    })

    socket.addEventListener('close', () => {
      setSocketReady(false)
      setSession({ state: 'error' })
      appendLog('Control link closed.')
    })

    socket.addEventListener('error', () => {
      setSession({ state: 'error' })
      appendLog('Control link is temporarily unavailable.')
    })

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return
      }

      const message = JSON.parse(event.data) as ServerMessage

      switch (message.type) {
        case 'hello':
        case 'session':
          setSession(message.session)

          if (message.session.serial) {
            setSelectedSerial((current) => current || message.session.serial || '')
          }

          if (message.session.width && message.session.height) {
            screenSizeRef.current = {
              width: message.session.width,
              height: message.session.height,
            }
            setScreenSize(screenSizeRef.current)
          }

          if (message.session.state === 'connected') {
            ensureDecoder(message.session)
          } else {
            resetDecoder()
          }
          break
        case 'devices':
          setDevices(message.devices)
          setSelectedSerial((current) => {
            if (current && message.devices.some((device) => device.serial === current)) {
              return current
            }

            return message.devices.find((device) => device.state === 'device')?.serial ?? ''
          })
          break
        case 'log':
          appendLog(message.line)
          break
        case 'error':
          appendLog(message.message)
          break
      }
    })

    const videoSocket = new WebSocket(`${protocol}://${window.location.host}/video`)
    videoSocket.binaryType = 'arraybuffer'
    videoSocketRef.current = videoSocket

    videoSocket.addEventListener('open', () => {
      setVideoReady(true)
    })

    videoSocket.addEventListener('close', () => {
      setVideoReady(false)
      resetDecoder()
    })

    videoSocket.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return
      }

      const packet = parseVideoPacket(event.data)
      const writer = decoderWriterRef.current
      if (!packet || !writer) {
        return
      }

      void writer.write(packet).catch((error) => {
        appendLog(`Video decode failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    return () => {
      socket.close()
      videoSocket.close()
    }
  }, [appendLog, ensureDecoder, resetDecoder])

  useEffect(() => {
    if (!socketReady) {
      return
    }

    const timer = window.setInterval(() => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'refresh-devices' }))
      }
    }, DEVICE_REFRESH_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [socketReady])

  useEffect(() => {
    if (session.state !== 'connected' || !session.serial) {
      frameCountRef.current = 0
      setEstimatedFps(0)
      return
    }

    frameCountRef.current = 0
    setEstimatedFps(0)

    const timer = window.setInterval(() => {
      const decoder = decoderRef.current
      if (!decoder) {
        setEstimatedFps(0)
        return
      }

      const renderedSinceLastSample = decoder.framesRendered - frameCountRef.current
      frameCountRef.current = decoder.framesRendered
      const measuredFps = Math.round((renderedSinceLastSample / (FPS_SAMPLE_MS / 1000)) * 10) / 10
      setEstimatedFps(measuredFps)
    }, FPS_SAMPLE_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [session.serial, session.state])

  const handleConnect = useCallback(
    (serial?: string) => {
      const nextSerial = serial || selectedSerial

      if (!nextSerial) {
        appendLog('Pick a device first.')
        return
      }

      setSelectedSerial(nextSerial)
      setSession((current) => ({ ...current, state: 'connecting' }))
      resetDecoder()
      sendMessage({
        type: 'connect-device',
        serial: nextSerial,
        videoBitRate: CAPTURE_BIT_RATE * 1_000_000,
        maxFps: TARGET_FPS,
      })
    },
    [appendLog, resetDecoder, selectedSerial, sendMessage],
  )

  const handleDisconnect = useCallback(() => {
    sendMessage({ type: 'disconnect-device' })
    setSession({ state: 'idle' })
    resetDecoder()
  }, [resetDecoder, sendMessage])

  const sendTouch = useCallback(
    (event: PointerEvent<HTMLCanvasElement>, action: number) => {
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }

      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) {
        return
      }

      const x = Math.max(
        0,
        Math.min(
          screenSizeRef.current.width,
          Math.round(((event.clientX - rect.left) / rect.width) * screenSizeRef.current.width),
        ),
      )
      const y = Math.max(
        0,
        Math.min(
          screenSizeRef.current.height,
          Math.round(((event.clientY - rect.top) / rect.height) * screenSizeRef.current.height),
        ),
      )

      sendMessage({
        type: 'touch',
        action,
        pointerX: x,
        pointerY: y,
        videoWidth: screenSizeRef.current.width,
        videoHeight: screenSizeRef.current.height,
      })
    },
    [sendMessage],
  )

  const handleTextSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()

      if (!typedText.trim()) {
        return
      }

      sendMessage({ type: 'send-text', text: typedText })
      setTypedText('')
    },
    [sendMessage, typedText],
  )

  const selectedDevice = useMemo(
    () => devices.find((device) => device.serial === selectedSerial),
    [devices, selectedSerial],
  )

  const availableDevices = useMemo(
    () => devices.filter((device) => device.state === 'device'),
    [devices],
  )

  const statusTone = useMemo(() => {
    switch (session.state) {
      case 'connected':
        return 'ok'
      case 'connecting':
        return 'warm'
      case 'error':
        return 'bad'
      default:
        return 'idle'
    }
  }, [session.state])

  const statusText = useMemo(() => {
    if (!socketReady) {
      return 'Service offline'
    }
    if (!videoReady) {
      return 'Video link offline'
    }
    if (!decoderSupported) {
      return 'WebCodecs unsupported'
    }

    switch (session.state) {
      case 'connected':
        return 'Live control'
      case 'connecting':
        return 'Connecting'
      case 'error':
        return 'Connection error'
      default:
        return 'Ready'
    }
  }, [decoderSupported, session.state, socketReady, videoReady])

  const canControl = session.state === 'connected'
  const activeDeviceName = session.name || selectedDevice?.model || 'No active device'

  return (
    <main className="app-shell">
      <section className="sidebar">
        <div className="panel panel-heading desktop-heading">
          <div>
            <p className="eyebrow">Web Scrcpy</p>
            <h2>Device Session</h2>
          </div>
          <span className={`status-pill ${statusTone}`}>{statusText}</span>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">Overview</label>
            <span className="inline-note">{availableDevices.length} ready</span>
          </div>
          <div className="stats-grid">
            <div className="stat-card">
              <span>Device</span>
              <strong>{activeDeviceName}</strong>
            </div>
            <div className="stat-card">
              <span>Target FPS</span>
              <strong>{TARGET_FPS} FPS</strong>
            </div>
            <div className="stat-card">
              <span>Measured FPS</span>
              <strong>{estimatedFps || 0} FPS</strong>
            </div>
            <div className="stat-card">
              <span>Bitrate</span>
              <strong>{CAPTURE_BIT_RATE} Mbps</strong>
            </div>
          </div>
          <p className="hint">Video now goes from scrcpy to the browser as raw packets, then decodes locally with WebCodecs.</p>
        </div>

        <div className="panel desktop-device-panel">
          <div className="panel-bar">
            <label className="field-label">Devices</label>
            <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
              Refresh
            </button>
          </div>
          <div className="device-strip vertical">
            {devices.length === 0 ? (
              <div className="empty-card">
                <strong>No device found</strong>
                <p className="hint">Check USB debugging and device authorization.</p>
              </div>
            ) : (
              devices.map((device) => {
                const isActive = session.serial === device.serial && canControl
                const isSelected = selectedSerial === device.serial
                const canStart = socketReady && videoReady && device.state === 'device' && session.state !== 'connecting'

                return (
                  <article
                    key={device.serial}
                    className={`device-tile${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                  >
                    <button type="button" className="device-tile-hitbox" onClick={() => setSelectedSerial(device.serial)}>
                      <div className="device-tile-head">
                        <strong>{(device.model || device.serial).trim()}</strong>
                        <span className={`device-badge ${device.state}`}>{DEVICE_STATE_LABEL[device.state]}</span>
                      </div>
                      <div className="device-meta">{device.serial}</div>
                      <div className="device-role">{isActive ? 'Live device' : isSelected ? 'Selected' : 'Tap to select'}</div>
                    </button>
                    <button
                      type="button"
                      className="primary-button tile-connect"
                      onClick={() => handleConnect(device.serial)}
                      disabled={!canStart}
                    >
                      {isActive ? 'Reconnect' : 'Connect'}
                    </button>
                  </article>
                )
              })
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">Path</label>
            <span className="inline-note">No audio</span>
          </div>
          <div className="settings-stack">
            <div className="setting-block">
              <div className="setting-head">
                <strong>Low-latency mode</strong>
                <span className="setting-value">
                  {CAPTURE_BIT_RATE} Mbps / {TARGET_FPS} FPS / 1280 max size
                </span>
              </div>
              <p className="hint">Control stays on WebSocket. Video skips server-side re-encode and decodes in the page.</p>
            </div>
          </div>
        </div>

        <form className="panel" onSubmit={handleTextSubmit}>
          <label className="field-label" htmlFor="text-input">
            Send text
          </label>
          <div className="text-row">
            <input
              id="text-input"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
              placeholder="Type text for the phone"
              disabled={!canControl}
            />
            <button type="submit" disabled={!canControl || !typedText.trim()}>
              Send
            </button>
          </div>
        </form>

        <div className="panel log-panel">
          <div className="panel-bar">
            <label className="field-label">Logs</label>
            <div className="panel-actions">
              <button type="button" className="ghost-button mobile-only" onClick={() => setShowLogs((current) => !current)}>
                {showLogs ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="ghost-button" onClick={() => setLogLines([])}>
                Clear
              </button>
            </div>
          </div>
          <div className={`log-list${showLogs ? ' show-mobile' : ''}`} aria-live="polite">
            {logLines.length === 0 ? (
              <p className="log-empty">No logs yet.</p>
            ) : (
              logLines.map((line) => (
                <div key={line} className="log-line">
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="stage">
        <div className="mobile-hero">
          <div>
            <p className="eyebrow">Web Scrcpy</p>
            <h1>Phone Control</h1>
          </div>
          <span className={`status-pill ${statusTone}`}>{statusText}</span>
        </div>

        <div className="mobile-summary">
          <div className="summary-chip">
            <span>Device</span>
            <strong>{activeDeviceName}</strong>
          </div>
          <div className="summary-chip">
            <span>FPS</span>
            <strong>{estimatedFps || 0}</strong>
          </div>
          <div className="summary-chip">
            <span>Bitrate</span>
            <strong>{CAPTURE_BIT_RATE} Mbps</strong>
          </div>
        </div>

        <div className="mobile-device-panel panel">
          <div className="panel-bar">
            <label className="field-label">Devices</label>
            <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
              Refresh
            </button>
          </div>
          <div className="device-strip">
            {devices.length === 0 ? (
              <div className="empty-card">
                <strong>No device found</strong>
                <p className="hint">Check USB debugging and authorization.</p>
              </div>
            ) : (
              devices.map((device) => {
                const isActive = session.serial === device.serial && canControl
                const isSelected = selectedSerial === device.serial
                const canStart = socketReady && videoReady && device.state === 'device' && session.state !== 'connecting'

                return (
                  <article
                    key={device.serial}
                    className={`device-tile${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                  >
                    <button type="button" className="device-tile-hitbox" onClick={() => setSelectedSerial(device.serial)}>
                      <div className="device-tile-head">
                        <strong>{(device.model || device.serial).trim()}</strong>
                        <span className={`device-badge ${device.state}`}>{DEVICE_STATE_LABEL[device.state]}</span>
                      </div>
                      <div className="device-meta">{device.serial}</div>
                      <div className="device-role">{isActive ? 'Live device' : isSelected ? 'Selected' : 'Tap to select'}</div>
                    </button>
                    <button
                      type="button"
                      className="primary-button tile-connect"
                      onClick={() => handleConnect(device.serial)}
                      disabled={!canStart}
                    >
                      {isActive ? 'Reconnect' : 'Connect'}
                    </button>
                  </article>
                )
              })
            )}
          </div>
        </div>

        <div className="stage-header">
          <div>
            <p className="eyebrow">Raw packet video</p>
            <h2>Live phone screen</h2>
          </div>
          <span className="resolution-tag">
            {screenSize.width} x {screenSize.height}
          </span>
        </div>

        <div className="screen-frame">
          <canvas
            ref={canvasRef}
            className="phone-screen"
            onPointerDown={(event) => {
              pointerDownRef.current = true
              event.currentTarget.setPointerCapture(event.pointerId)
              sendTouch(event, AndroidMotionEventAction.Down)
            }}
            onPointerMove={(event) => {
              if (!pointerDownRef.current) {
                return
              }
              sendTouch(event, AndroidMotionEventAction.Move)
            }}
            onPointerUp={(event) => {
              pointerDownRef.current = false
              sendTouch(event, AndroidMotionEventAction.Up)
            }}
            onPointerCancel={(event) => {
              pointerDownRef.current = false
              sendTouch(event, AndroidMotionEventAction.Cancel)
            }}
          />
          {!canControl && (
            <div className="screen-overlay">
              <span>
                {!socketReady
                  ? 'Waiting for the service.'
                  : !videoReady
                    ? 'Waiting for the video link.'
                    : !decoderSupported
                      ? 'This browser does not support WebCodecs.'
                      : 'Choose a device and start mirroring.'}
              </span>
            </div>
          )}
        </div>

        <div className="panel quick-panel">
          <label className="field-label">Quick controls</label>
          <div className="control-grid">
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'back' })} disabled={!canControl}>
              Back
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'home' })} disabled={!canControl}>
              Home
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'app-switch' })} disabled={!canControl}>
              Apps
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'screen-off' })} disabled={!canControl}>
              Screen off
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'rotate' })} disabled={!canControl}>
              Rotate
            </button>
            <button type="button" onClick={handleDisconnect} disabled={!socketReady || session.state === 'idle'}>
              Stop
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
