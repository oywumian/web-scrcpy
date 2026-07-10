import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react'
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
const BITRATE_SAMPLE_MS = 1000
const TARGET_FPS = 60
const CAPTURE_BIT_RATE = 6
const MIN_QUALITY_BITRATE = 2
const MAX_QUALITY_BITRATE = 12

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
  const [videoFrameSize, setVideoFrameSize] = useState({ width: 1080, height: 1920 })
  const [estimatedFps, setEstimatedFps] = useState(0)
  const [estimatedBitrateMbps, setEstimatedBitrateMbps] = useState(0)
  const [selectedQualityBitrateMbps, setSelectedQualityBitrateMbps] = useState(CAPTURE_BIT_RATE)
  const [screenOffWhileRunning, setScreenOffWhileRunning] = useState(true)
  const [isMobileViewport, setIsMobileViewport] = useState(() => window.innerWidth <= 1024)
  const [typedText, setTypedText] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [socketReady, setSocketReady] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [decoderSupported, setDecoderSupported] = useState(true)
  const [mobilePage, setMobilePage] = useState<'devices' | 'control'>('devices')

  const socketRef = useRef<WebSocket | null>(null)
  const videoSocketRef = useRef<WebSocket | null>(null)
  const clientIdRef = useRef(
    globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const desktopCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const mobileCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null)
  const decoderWriterRef = useRef<WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null>(null)
  const screenSizeRef = useRef({ width: 1080, height: 1920 })
  const pointerDownRef = useRef(false)
  const frameCountRef = useRef(0)
  const videoBytesRef = useRef(0)

  const appendLog = useCallback((line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    setLogLines((current) => [...current.slice(-MAX_LOG_LINES + 1), stamped])
  }, [])

  const getActiveCanvas = useCallback(() => {
    return isMobileViewport ? mobileCanvasRef.current : desktopCanvasRef.current
  }, [isMobileViewport])

  const resetDecoder = useCallback(() => {
    decoderWriterRef.current?.releaseLock()
    decoderWriterRef.current = null
    decoderRef.current?.dispose()
    decoderRef.current = null
    frameCountRef.current = 0
    setEstimatedFps(0)
    videoBytesRef.current = 0
    setEstimatedBitrateMbps(0)
    setVideoFrameSize({ width: 1080, height: 1920 })

    const canvas = getActiveCanvas()
    if (canvas) {
      const context = canvas.getContext('2d')
      if (context) {
        context.clearRect(0, 0, canvas.width, canvas.height)
      }
    }
  }, [getActiveCanvas])

  const ensureDecoder = useCallback(
    (nextSession: SessionInfo) => {
      const canvas = getActiveCanvas()
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
        setVideoFrameSize({ width, height })
      })

      decoderRef.current = decoder
      decoderWriterRef.current = decoder.writable.getWriter()
      setDecoderSupported(true)
    },
    [getActiveCanvas, resetDecoder],
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
    const handleResize = () => {
      setIsMobileViewport(window.innerWidth <= 1024)
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    return () => {
      resetDecoder()
      socketRef.current?.close()
      videoSocketRef.current?.close()
    }
  }, [resetDecoder])

  useEffect(() => {
    if (session.state === 'connected' && session.codec) {
      ensureDecoder(session)
    }
  }, [ensureDecoder, isMobileViewport, session])

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const clientQuery = `clientId=${encodeURIComponent(clientIdRef.current)}`

    const socket = new WebSocket(`${protocol}://${window.location.host}/ws?${clientQuery}`)
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
            setVideoFrameSize({
              width: message.session.width,
              height: message.session.height,
            })
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

    const videoSocket = new WebSocket(`${protocol}://${window.location.host}/video?${clientQuery}`)
    videoSocket.binaryType = 'arraybuffer'
    videoSocketRef.current = videoSocket

    videoSocket.addEventListener('open', () => {
      setVideoReady(true)
    })

    videoSocket.addEventListener('close', () => {
      setVideoReady(false)
      videoBytesRef.current = 0
      setEstimatedBitrateMbps(0)
      resetDecoder()
    })

    videoSocket.addEventListener('message', (event) => {
      if (!(event.data instanceof ArrayBuffer)) {
        return
      }

      videoBytesRef.current += event.data.byteLength

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

  useEffect(() => {
    if (session.state !== 'connected' || !session.serial || !videoReady) {
      videoBytesRef.current = 0
      setEstimatedBitrateMbps(0)
      return
    }

    videoBytesRef.current = 0
    setEstimatedBitrateMbps(0)

    const timer = window.setInterval(() => {
      const bitrateMbps = (videoBytesRef.current * 8) / (BITRATE_SAMPLE_MS / 1000) / 1_000_000
      setEstimatedBitrateMbps(Math.round(bitrateMbps * 10) / 10)
      videoBytesRef.current = 0
    }, BITRATE_SAMPLE_MS)

    return () => {
      window.clearInterval(timer)
    }
  }, [session.serial, session.state, videoReady])

  const handleConnect = useCallback(
    (serial?: string, options?: { openControlPage?: boolean }) => {
      const nextSerial = serial || selectedSerial

      if (!nextSerial) {
        appendLog('Pick a device first.')
        return
      }

      setSelectedSerial(nextSerial)
      setSession((current) => ({ ...current, state: 'connecting' }))
      resetDecoder()
      if (options?.openControlPage) {
        setMobilePage('control')
      }
      sendMessage({
        type: 'connect-device',
        serial: nextSerial,
        screenOff: screenOffWhileRunning,
        videoBitRate: selectedQualityBitrateMbps * 1_000_000,
        maxFps: TARGET_FPS,
      })
    },
    [appendLog, resetDecoder, screenOffWhileRunning, selectedQualityBitrateMbps, selectedSerial, sendMessage],
  )

  const sendCommand = useCallback(
    (command: string) => {
      sendMessage({ type: 'command', command })
    },
    [sendMessage],
  )

  const handleExitControlPage = useCallback(() => {
    sendMessage({ type: 'disconnect-device' })
    resetDecoder()
    setSession({ state: 'idle' })
    setMobilePage('devices')
  }, [resetDecoder, sendMessage])

  const sendDesktopTouch = useCallback(
    (event: PointerEvent<HTMLCanvasElement>, action: number) => {
      const canvas = desktopCanvasRef.current
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

  const sendMobileTouch = useCallback(
    (event: PointerEvent<HTMLCanvasElement>, action: number) => {
      const canvas = mobileCanvasRef.current
      if (!canvas) {
        return
      }

      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) {
        return
      }

      const normalizedX = (event.clientX - rect.left) / rect.width
      const normalizedY = (event.clientY - rect.top) / rect.height
      const shouldRotateLandscapeVideo = videoFrameSize.width > videoFrameSize.height

      const x = Math.max(
        0,
        Math.min(
          screenSizeRef.current.width,
          Math.round((shouldRotateLandscapeVideo ? normalizedY : normalizedX) * screenSizeRef.current.width),
        ),
      )
      const y = Math.max(
        0,
        Math.min(
          screenSizeRef.current.height,
          Math.round((shouldRotateLandscapeVideo ? 1 - normalizedX : normalizedY) * screenSizeRef.current.height),
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
    [sendMessage, videoFrameSize.height, videoFrameSize.width],
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
  const isLandscapeVideo = videoFrameSize.width > videoFrameSize.height
  const displayedAspectRatio = isLandscapeVideo
    ? `${videoFrameSize.height} / ${videoFrameSize.width}`
    : `${videoFrameSize.width} / ${videoFrameSize.height}`
  const mobileDisplayContentStyle = {
    aspectRatio: displayedAspectRatio,
    height: '100%',
    ...(isLandscapeVideo
      ? {
          '--rotate-width-scale': String(videoFrameSize.width / videoFrameSize.height),
          '--rotate-height-scale': String(videoFrameSize.height / videoFrameSize.width),
        }
      : {}),
  } as CSSProperties
  const desktopDisplayContentStyle = {
    aspectRatio: `${videoFrameSize.width} / ${videoFrameSize.height}`,
    ...(isLandscapeVideo
      ? {
          width: '100%',
          maxHeight: '100%',
        }
      : {
          height: '100%',
          maxWidth: '100%',
        }),
  } as CSSProperties

  const renderDeviceCard = useCallback(
    (device: DeviceInfo, options?: { mobile?: boolean }) => {
      const isActive = session.serial === device.serial && canControl
      const isSelected = selectedSerial === device.serial
      const canStart = socketReady && videoReady && device.state === 'device' && session.state !== 'connecting'
      const mobile = options?.mobile

      return (
        <article
          key={device.serial}
          className={`device-tile${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}${mobile ? ' mobile-list-card' : ''}`}
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
            onClick={() => handleConnect(device.serial, mobile ? { openControlPage: true } : undefined)}
            disabled={!canStart}
          >
            {isActive ? 'Reconnect' : mobile ? 'Select and open' : 'Connect'}
          </button>
        </article>
      )
    },
    [canControl, handleConnect, selectedSerial, session.serial, session.state, socketReady, videoReady],
  )

  return (
    <main className="app-shell">
      <section className="sidebar">
        <div className="desktop-console">
          <div className="panel panel-heading desktop-heading">
            <div>
              <p className="eyebrow">Web Scrcpy</p>
              <h2>Desktop Control</h2>
            </div>
            <span className={`status-pill ${statusTone}`}>{statusText}</span>
          </div>

          <div className="panel desktop-panel-block">
            <div className="panel-bar">
              <label className="field-label">Session</label>
              <span className="inline-note">{availableDevices.length} ready</span>
            </div>
            <div className="desktop-toolbar-grid">
              <div className="desktop-toolbar-tile metric">
                <span>FPS</span>
                <strong>{estimatedFps || 0}</strong>
              </div>
              <div className="desktop-toolbar-tile metric">
                <strong>{estimatedBitrateMbps || 0} Mbps</strong>
              </div>
              <button
                type="button"
                className="desktop-toolbar-tile action"
                onClick={() => handleConnect(session.serial || selectedSerial)}
                disabled={!selectedSerial || session.state === 'connecting'}
              >
                Refresh
              </button>
              <button type="button" className="ghost-button" onClick={() => setLogLines([])}>
                Clear logs
              </button>
            </div>

            <div className="desktop-setting-card">
              <div className="mobile-quality-head">
                <span className="field-label">Clarity</span>
                <span className="inline-note">{selectedQualityBitrateMbps} Mbps / 60 FPS</span>
              </div>
              <div className="mobile-quality-slider">
                <input
                  type="range"
                  min={String(MIN_QUALITY_BITRATE)}
                  max={String(MAX_QUALITY_BITRATE)}
                  step="1"
                  value={String(selectedQualityBitrateMbps)}
                  onChange={(event) => setSelectedQualityBitrateMbps(Number(event.target.value))}
                />
                <div className="mobile-quality-scale" aria-hidden="true">
                  <span className="quality-scale-mark">{MIN_QUALITY_BITRATE} Mbps</span>
                  <span className="quality-scale-mark active">{selectedQualityBitrateMbps} Mbps</span>
                  <span className="quality-scale-mark">{MAX_QUALITY_BITRATE} Mbps</span>
                </div>
              </div>
            </div>

            <div className="desktop-setting-card desktop-screenoff-card">
              <div>
                <span className="field-label">Run with screen off</span>
                <p className="hint section-hint">Keep mirroring while the device display stays off.</p>
              </div>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={screenOffWhileRunning}
                  onChange={(event) => setScreenOffWhileRunning(event.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </div>

            <div className="desktop-setting-card desktop-screen-debug-card">
              <div className="panel-bar">
                <label className="field-label">Screen power test</label>
                <span className="inline-note">Debug</span>
              </div>
              <div className="desktop-screen-debug-actions">
                <button type="button" onClick={() => sendCommand('screen-off')} disabled={!canControl}>
                  Test screen off
                </button>
                <button type="button" onClick={() => sendCommand('screen-on')} disabled={!canControl}>
                  Wake screen
                </button>
              </div>
            </div>
          </div>

          <div className="panel desktop-device-panel">
            <div className="panel-bar">
              <label className="field-label">Devices</label>
              <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
                Refresh
              </button>
            </div>
            <div className="device-strip vertical desktop-device-strip">
              {devices.length === 0 ? (
                <div className="empty-card">
                  <strong>No device found</strong>
                  <p className="hint">Check USB debugging and device authorization.</p>
                </div>
              ) : (
                devices.map((device) => renderDeviceCard(device))
              )}
            </div>
          </div>

          <form className="panel desktop-text-panel" onSubmit={handleTextSubmit}>
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

          <div className="panel log-panel desktop-log-panel">
            <div className="panel-bar">
              <label className="field-label">Logs</label>
            </div>
            <div className="log-list desktop-log-list" aria-live="polite">
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
        </div>
      </section>

      <section className="stage">
        {!isMobileViewport ? (
          <div className="desktop-stage-shell">
            <div className="desktop-screen-wrap">
              <div className="desktop-screen-toolbar">
                <div className="desktop-device-badge">
                  <span>Device</span>
                  <strong>{session.serial || activeDeviceName}</strong>
                </div>
                <div className="desktop-nav-dock">
                  <button type="button" onClick={() => sendCommand('back')} disabled={!canControl}>
                    Back
                  </button>
                  <button type="button" onClick={() => sendCommand('home')} disabled={!canControl}>
                    Home
                  </button>
                  <button type="button" onClick={() => sendCommand('app-switch')} disabled={!canControl}>
                    Apps
                  </button>
                </div>
              </div>

              <div className="desktop-display-stage">
                <div className="desktop-display-content" style={desktopDisplayContentStyle}>
                  <canvas
                    ref={desktopCanvasRef}
                    className="desktop-display-canvas"
                    onPointerDown={(event) => {
                      pointerDownRef.current = true
                      event.currentTarget.setPointerCapture(event.pointerId)
                      sendDesktopTouch(event, AndroidMotionEventAction.Down)
                    }}
                    onPointerMove={(event) => {
                      if (!pointerDownRef.current) {
                        return
                      }
                      sendDesktopTouch(event, AndroidMotionEventAction.Move)
                    }}
                    onPointerUp={(event) => {
                      pointerDownRef.current = false
                      sendDesktopTouch(event, AndroidMotionEventAction.Up)
                    }}
                    onPointerCancel={(event) => {
                      pointerDownRef.current = false
                      sendDesktopTouch(event, AndroidMotionEventAction.Cancel)
                    }}
                  />
                </div>

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
            </div>
          </div>
        ) : (
          <div className="mobile-shell">
          {mobilePage === 'devices' ? (
            <div className="mobile-home-scroll">
              <div className="mobile-hero devices-home-hero">
                <div>
                  <p className="eyebrow">Web Scrcpy</p>
                  <h1>Choose Device</h1>
                </div>
                <span className={`status-pill ${statusTone}`}>{statusText}</span>
              </div>

              <div className="mobile-device-home panel">
                <div className="panel-bar">
                  <div>
                    <label className="field-label">Devices</label>
                    <p className="hint section-hint">Home only selects the device. Screen and controls live on the next page.</p>
                  </div>
                  <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
                    Refresh
                  </button>
                </div>
                <div className="mobile-quality-panel">
                  <div className="mobile-quality-head">
                    <span className="field-label">Clarity</span>
                    <span className="inline-note">
                      {selectedQualityBitrateMbps} Mbps / 60 FPS
                    </span>
                  </div>
                  <div className="mobile-quality-slider">
                    <input
                      type="range"
                      min={String(MIN_QUALITY_BITRATE)}
                      max={String(MAX_QUALITY_BITRATE)}
                      step="1"
                      value={String(selectedQualityBitrateMbps)}
                      onChange={(event) => setSelectedQualityBitrateMbps(Number(event.target.value))}
                    />
                    <div className="mobile-quality-scale" aria-hidden="true">
                      <span className="quality-scale-mark">{MIN_QUALITY_BITRATE} Mbps</span>
                      <span className="quality-scale-mark active">{selectedQualityBitrateMbps} Mbps</span>
                      <span className="quality-scale-mark">{MAX_QUALITY_BITRATE} Mbps</span>
                    </div>
                  </div>
                </div>
                <div className="mobile-run-option">
                  <div>
                    <span className="field-label">Run with screen off</span>
                    <p className="hint section-hint">Keep mirroring while the physical device display stays off.</p>
                  </div>
                  <label className="switch-toggle">
                    <input
                      type="checkbox"
                      checked={screenOffWhileRunning}
                      onChange={(event) => setScreenOffWhileRunning(event.target.checked)}
                    />
                    <span className="switch-slider" />
                  </label>
                </div>
                <div className="mobile-device-list">
                  {devices.length === 0 ? (
                    <div className="empty-card">
                      <strong>No device found</strong>
                      <p className="hint">Check USB debugging and authorization.</p>
                    </div>
                  ) : (
                    devices.map((device) => renderDeviceCard(device, { mobile: true }))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="mobile-control-page">
              <div className="mobile-control-toolbar">
                <div className="mobile-toolbar-tile metric">
                  <span>FPS</span>
                  <strong>{estimatedFps || 0}</strong>
                </div>
                <div className="mobile-toolbar-tile metric">
                  <strong>{estimatedBitrateMbps || 0} Mbps</strong>
                </div>
                <button
                  type="button"
                  className="mobile-toolbar-tile action"
                  onClick={() => handleConnect(session.serial || selectedSerial)}
                  disabled={!selectedSerial || session.state === 'connecting'}
                >
                  Refresh
                </button>
                <button type="button" className="mobile-toolbar-tile action" onClick={handleExitControlPage}>
                  Back
                </button>
              </div>

              <div className="mobile-display-shell">
                <div className={`mobile-display-stage${isLandscapeVideo ? ' landscape-feed' : ' portrait-feed'}`}>
                  <div className="mobile-display-content" style={mobileDisplayContentStyle}>
                    <canvas
                      ref={mobileCanvasRef}
                      className={`mobile-display-canvas${isLandscapeVideo ? ' rotated-landscape-canvas' : ''}`}
                      onPointerDown={(event) => {
                        pointerDownRef.current = true
                        event.currentTarget.setPointerCapture(event.pointerId)
                        sendMobileTouch(event, AndroidMotionEventAction.Down)
                      }}
                      onPointerMove={(event) => {
                        if (!pointerDownRef.current) {
                          return
                        }
                        sendMobileTouch(event, AndroidMotionEventAction.Move)
                      }}
                      onPointerUp={(event) => {
                        pointerDownRef.current = false
                        sendMobileTouch(event, AndroidMotionEventAction.Up)
                      }}
                      onPointerCancel={(event) => {
                        pointerDownRef.current = false
                        sendMobileTouch(event, AndroidMotionEventAction.Cancel)
                      }}
                    />
                  </div>

                  {!canControl && (
                    <div className="mobile-display-overlay">
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
              </div>

              <div className="mobile-control-dock">
                <button type="button" onClick={() => sendCommand('back')} disabled={!canControl}>
                  Back
                </button>
                <button type="button" onClick={() => sendCommand('home')} disabled={!canControl}>
                  Home
                </button>
                <button type="button" onClick={() => sendCommand('app-switch')} disabled={!canControl}>
                  Apps
                </button>
              </div>
            </div>
          )}
          </div>
        )}
      </section>
    </main>
  )
}

export default App
