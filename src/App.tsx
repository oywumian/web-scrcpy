import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { AndroidMotionEventAction, type ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
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
  | { type: 'webrtc-answer'; sdp?: string }
  | { type: 'webrtc-ice-candidate'; candidate: RTCIceCandidateInit }

const MAX_LOG_LINES = 150
const DEVICE_REFRESH_MS = 5000
const FPS_SAMPLE_MS = 5000
const TARGET_FPS = 60
const CAPTURE_BIT_RATE = 12

const DEVICE_STATE_LABEL: Record<DeviceState, string> = {
  device: '可连接',
  offline: '离线',
  unauthorized: '未授权',
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
  const [showLogs, setShowLogs] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const screenSizeRef = useRef({ width: 1080, height: 1920 })
  const pointerDownRef = useRef(false)
  const frameCountRef = useRef(0)

  const appendLog = useCallback((line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    setLogLines((current) => [...current.slice(-MAX_LOG_LINES + 1), stamped])
  }, [])

  const disposePeer = useCallback(() => {
    pointerDownRef.current = false

    const peer = peerRef.current
    peerRef.current = null

    if (peer) {
      try {
        peer.ontrack = null
        peer.onicecandidate = null
        peer.close()
      } catch {
        // Ignore close races.
      }
    }

    const video = videoRef.current
    if (video) {
      video.srcObject = null
    }
  }, [])

  const sendMessage = useCallback(
    (payload: object) => {
      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        appendLog('浏览器还没有连到控制服务。')
        return false
      }

      socket.send(JSON.stringify(payload))
      return true
    },
    [appendLog],
  )

  const startWebRtc = useCallback(async (serialOverride?: string) => {
    const targetSerial = serialOverride ?? session.serial

    if (!socketReady || !targetSerial || peerRef.current) {
      return
    }

    const peer = new RTCPeerConnection({
      iceServers: [],
    })

    peerRef.current = peer
    peer.addTransceiver('video', { direction: 'recvonly' })

    peer.ontrack = (event) => {
      const video = videoRef.current
      if (!video) {
        return
      }

      const [stream] = event.streams
      if (stream) {
        video.srcObject = stream
      } else {
        video.srcObject = new MediaStream([event.track])
      }
    }

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        sendMessage({
          type: 'webrtc-ice-candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)

    const sent = sendMessage({
      type: 'webrtc-offer',
      sdp: offer.sdp,
    })

    if (!sent) {
      disposePeer()
    }
  }, [disposePeer, sendMessage, session.serial, socketReady])

  useEffect(() => {
    return () => {
      disposePeer()
      socketRef.current?.close()
    }
  }, [disposePeer])

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
      disposePeer()
      appendLog('共享控制服务已断开。')
    })

    socket.addEventListener('error', () => {
      setSession({ state: 'error' })
      appendLog('共享控制服务暂时不可用。')
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

          if (message.session.state !== 'connected') {
            disposePeer()
          } else if (message.session.serial) {
            void startWebRtc(message.session.serial)
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
        case 'webrtc-answer': {
          const peer = peerRef.current
          if (!peer || !message.sdp) {
            return
          }

          void peer.setRemoteDescription({
            type: 'answer',
            sdp: message.sdp,
          })
          break
        }
        case 'webrtc-ice-candidate': {
          const peer = peerRef.current
          if (!peer) {
            return
          }

          void peer.addIceCandidate(message.candidate)
          break
        }
      }
    })

    return () => {
      socket.close()
    }
  }, [appendLog, disposePeer])

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
    if (session.state === 'connected') {
      void startWebRtc()
      return
    }

    disposePeer()
  }, [disposePeer, session.state, startWebRtc])

  useEffect(() => {
    if (!socketReady || session.state !== 'connected' || !session.serial) {
      return
    }

    const timer = window.setTimeout(() => {
      const video = videoRef.current
      const hasFrame = Boolean(video?.srcObject) || Boolean(video && video.readyState >= 2 && !video.paused)
      if (hasFrame) {
        return
      }

      disposePeer()
      sendMessage({
        type: 'connect-device',
        serial: session.serial,
        videoBitRate: CAPTURE_BIT_RATE * 1_000_000,
        maxFps: TARGET_FPS,
      })
    }, 1800)

    return () => {
      window.clearTimeout(timer)
    }
  }, [disposePeer, sendMessage, session.serial, session.state, socketReady])

  useEffect(() => {
    if (session.state !== 'connected' || !session.serial) {
      frameCountRef.current = 0
      setEstimatedFps(0)
      return
    }

    frameCountRef.current = 0
    setEstimatedFps(0)

    const video = videoRef.current
    const videoWithFrameCallback = video as
      | (HTMLVideoElement & {
          requestVideoFrameCallback: (cb: () => void) => number
        })
      | null

    if (videoWithFrameCallback && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const frameCallback = () => {
        frameCountRef.current += 1
        videoWithFrameCallback.requestVideoFrameCallback(frameCallback)
      }

      videoWithFrameCallback.requestVideoFrameCallback(frameCallback)
    }

    const timer = window.setInterval(() => {
      const elapsedSeconds = FPS_SAMPLE_MS / 1000
      const measuredFps = Math.round((frameCountRef.current / elapsedSeconds) * 10) / 10

      frameCountRef.current = 0
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
        appendLog('请先选择一台设备。')
        return
      }

      setSelectedSerial(nextSerial)
      setSession((current) => ({ ...current, state: 'connecting' }))
      sendMessage({
        type: 'connect-device',
        serial: nextSerial,
        videoBitRate: CAPTURE_BIT_RATE * 1_000_000,
        maxFps: TARGET_FPS,
      })
    },
    [appendLog, selectedSerial, sendMessage],
  )

  const handleDisconnect = useCallback(() => {
    sendMessage({ type: 'disconnect-device' })
    setSession({ state: 'idle' })
    disposePeer()
  }, [disposePeer, sendMessage])

  const sendTouch = useCallback(
    (event: PointerEvent<HTMLVideoElement>, action: number) => {
      const video = videoRef.current
      if (!video) {
        return
      }

      const rect = video.getBoundingClientRect()
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
      return '服务离线'
    }

    switch (session.state) {
      case 'connected':
        return '正在控制'
      case 'connecting':
        return '正在启动投屏'
      case 'error':
        return '连接异常'
      default:
        return '准备就绪'
    }
  }, [session.state, socketReady])

  const canControl = session.state === 'connected'
  const activeDeviceName = session.name || selectedDevice?.model || '当前没有活动镜像'

  return (
    <main className="app-shell">
      <section className="sidebar">
        <div className="panel panel-heading desktop-heading">
          <div>
            <p className="eyebrow">共享版 Web Scrcpy</p>
            <h2>设备与会话</h2>
          </div>
          <span className={`status-pill ${statusTone}`}>{statusText}</span>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">会话概览</label>
            <span className="inline-note">{availableDevices.length} 台可连接</span>
          </div>
          <div className="stats-grid">
            <div className="stat-card">
              <span>当前设备</span>
              <strong>{activeDeviceName}</strong>
            </div>
            <div className="stat-card">
              <span>目标帧率</span>
              <strong>{TARGET_FPS} FPS</strong>
            </div>
            <div className="stat-card">
              <span>估算帧率</span>
              <strong>{estimatedFps || 0} FPS</strong>
            </div>
            <div className="stat-card">
              <span>采集码率</span>
              <strong>{CAPTURE_BIT_RATE} Mbps</strong>
            </div>
          </div>
          <p className="hint">视频已经切到后端 WebRTC 分发，浏览器只负责收视频和发控制指令。</p>
        </div>

        <div className="panel desktop-device-panel">
          <div className="panel-bar">
            <label className="field-label">设备切换</label>
            <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
              刷新
            </button>
          </div>
          <div className="device-strip vertical">
            {devices.length === 0 ? (
              <div className="empty-card">
                <strong>还没有发现设备</strong>
                <p className="hint">请确认手机已连接，并允许 USB 调试。</p>
              </div>
            ) : (
              devices.map((device) => {
                const isActive = session.serial === device.serial && canControl
                const isSelected = selectedSerial === device.serial
                const canStart = socketReady && device.state === 'device' && session.state !== 'connecting'

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
                      <div className="device-role">
                        {isActive ? '当前镜像设备' : isSelected ? '已选中' : '点一下选择'}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="primary-button tile-connect"
                      onClick={() => handleConnect(device.serial)}
                      disabled={!canStart}
                    >
                      {isActive ? '重连' : '连接'}
                    </button>
                  </article>
                )
              })
            )}
          </div>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">连接策略</label>
            <span className="inline-note">视频单路、无音频</span>
          </div>
          <div className="settings-stack">
            <div className="setting-block">
              <div className="setting-head">
                <strong>后端采集</strong>
                <span className="setting-value">固定 {CAPTURE_BIT_RATE} Mbps / {TARGET_FPS} FPS</span>
              </div>
              <p className="hint">手机通过 USB 走高质量 scrcpy 采集，前端通过 WebRTC 收视频。</p>
              <p className="hint">这一版先移除了“低帧率自动重连降码率”，避免前端误判导致反复重连。</p>
            </div>
          </div>
        </div>

        <form className="panel" onSubmit={handleTextSubmit}>
          <label className="field-label" htmlFor="text-input">
            发送文本
          </label>
          <div className="text-row">
            <input
              id="text-input"
              value={typedText}
              onChange={(event) => setTypedText(event.target.value)}
              placeholder="输入要发送到手机的文字"
              disabled={!canControl}
            />
            <button type="submit" disabled={!canControl || !typedText.trim()}>
              发送
            </button>
          </div>
        </form>

        <div className="panel log-panel">
          <div className="panel-bar">
            <label className="field-label">运行日志</label>
            <div className="panel-actions">
              <button type="button" className="ghost-button mobile-only" onClick={() => setShowLogs((current) => !current)}>
                {showLogs ? '收起' : '展开'}
              </button>
              <button type="button" className="ghost-button" onClick={() => setLogLines([])}>
                清空
              </button>
            </div>
          </div>
          <div className={`log-list${showLogs ? ' show-mobile' : ''}`} aria-live="polite">
            {logLines.length === 0 ? (
              <p className="log-empty">还没有日志。</p>
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
            <p className="eyebrow">共享版 Web Scrcpy</p>
            <h1>手机端控制台</h1>
          </div>
          <span className={`status-pill ${statusTone}`}>{statusText}</span>
        </div>

        <div className="mobile-summary">
          <div className="summary-chip">
            <span>当前设备</span>
            <strong>{activeDeviceName}</strong>
          </div>
          <div className="summary-chip">
            <span>估算帧率</span>
            <strong>{estimatedFps || 0} FPS</strong>
          </div>
          <div className="summary-chip">
            <span>采集码率</span>
            <strong>{CAPTURE_BIT_RATE} Mbps</strong>
          </div>
        </div>

        <div className="panel mobile-device-panel">
          <div className="panel-bar">
            <label className="field-label">设备切换</label>
            <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
              刷新
            </button>
          </div>
          <div className="device-strip">
            {devices.length === 0 ? (
              <div className="empty-card">
                <strong>还没有发现设备</strong>
                <p className="hint">请确认手机已连接，并允许 USB 调试。</p>
              </div>
            ) : (
              devices.map((device) => {
                const isActive = session.serial === device.serial && canControl
                const isSelected = selectedSerial === device.serial
                const canStart = socketReady && device.state === 'device' && session.state !== 'connecting'

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
                      <div className="device-role">
                        {isActive ? '当前镜像设备' : isSelected ? '已选中' : '点一下选择'}
                      </div>
                    </button>
                    <button
                      type="button"
                      className="primary-button tile-connect"
                      onClick={() => handleConnect(device.serial)}
                      disabled={!canStart}
                    >
                      {isActive ? '重连' : '连接'}
                    </button>
                  </article>
                )
              })
            )}
          </div>
        </div>

        <div className="stage-header">
          <div>
            <p className="eyebrow">WebRTC 画面</p>
            <h2>实时共享画面</h2>
          </div>
          <span className="resolution-tag">
            {screenSize.width} x {screenSize.height}
          </span>
        </div>

        <div className="screen-frame">
          <video
            ref={videoRef}
            className="phone-screen"
            autoPlay
            muted
            playsInline
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
              <span>{socketReady ? '请选择设备并启动投屏。' : '正在等待控制服务。'}</span>
            </div>
          )}
        </div>

        <div className="panel quick-panel">
          <label className="field-label">快捷控制</label>
          <div className="control-grid">
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'back' })} disabled={!canControl}>
              返回
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'home' })} disabled={!canControl}>
              主页
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'app-switch' })} disabled={!canControl}>
              多任务
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'screen-off' })} disabled={!canControl}>
              熄屏
            </button>
            <button type="button" onClick={() => sendMessage({ type: 'command', command: 'rotate' })} disabled={!canControl}>
              旋转
            </button>
            <button type="button" onClick={handleDisconnect} disabled={!socketReady || session.state === 'idle'}>
              停止
            </button>
          </div>
        </div>
      </section>
    </main>
  )
}

export default App
