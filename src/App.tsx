import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react'
import { AndroidMotionEventAction, type ScrcpyMediaStreamPacket, type ScrcpyVideoCodecId } from '@yume-chan/scrcpy'
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from '@yume-chan/scrcpy-decoder-webcodecs'
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
  | {
      type: 'video'
      packet: {
        data: string
        keyframe?: boolean
        kind: 'configuration' | 'data'
        pts?: string
      }
    }

const MAX_LOG_LINES = 150
const DEVICE_REFRESH_MS = 5000

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
  const [bitRate, setBitRate] = useState(4)
  const [fps, setFps] = useState(30)
  const [typedText, setTypedText] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [socketReady, setSocketReady] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const decoderRef = useRef<WebCodecsVideoDecoder | null>(null)
  const packetWriterRef = useRef<WritableStreamDefaultWriter<ScrcpyMediaStreamPacket> | null>(null)
  const screenSizeRef = useRef({ width: 1080, height: 1920 })
  const removeSizeListenerRef = useRef<(() => void) | null>(null)
  const pointerDownRef = useRef(false)

  const appendLog = useCallback((line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`
    setLogLines((current) => [...current.slice(-MAX_LOG_LINES + 1), stamped])
  }, [])

  const disposeDecoder = useCallback(async () => {
    pointerDownRef.current = false

    const writer = packetWriterRef.current
    packetWriterRef.current = null
    if (writer) {
      try {
        await writer.close()
      } catch {
        // Decoder teardown can race with the stream finishing.
      }
    }

    const decoder = decoderRef.current
    decoderRef.current = null
    removeSizeListenerRef.current?.()
    removeSizeListenerRef.current = null
    decoder?.dispose()
  }, [])

  const createDecoder = useCallback(
    async (nextSession: SessionInfo) => {
      if (!nextSession.codec || !canvasRef.current) {
        return
      }

      await disposeDecoder()

      screenSizeRef.current = {
        width: nextSession.width || 1080,
        height: nextSession.height || 1920,
      }
      setScreenSize(screenSizeRef.current)

      const renderer = WebGLVideoFrameRenderer.isSupported
        ? new WebGLVideoFrameRenderer(canvasRef.current)
        : new BitmapVideoFrameRenderer(canvasRef.current)

      const decoder = new WebCodecsVideoDecoder({
        codec: nextSession.codec,
        renderer,
      })

      decoderRef.current = decoder
      removeSizeListenerRef.current = decoder.sizeChanged(({ width, height }) => {
        screenSizeRef.current = { width, height }
        setScreenSize({ width, height })
      })
      packetWriterRef.current = decoder.writable.getWriter()
    },
    [disposeDecoder],
  )

  useEffect(() => {
    return () => {
      void disposeDecoder()
      socketRef.current?.close()
    }
  }, [disposeDecoder])

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
          if (message.session.state !== 'connected') {
            void disposeDecoder()
          } else {
            void createDecoder(message.session)
          }
          break
        case 'devices':
          setDevices(message.devices)
          setSelectedSerial((current) => {
            if (current && message.devices.some((device) => device.serial === current)) {
              return current
            }

            return message.devices[0]?.serial ?? ''
          })
          break
        case 'log':
          appendLog(message.line)
          break
        case 'error':
          appendLog(message.message)
          break
        case 'video': {
          const writer = packetWriterRef.current
          if (!writer) {
            return
          }

          const data = Uint8Array.from(atob(message.packet.data), (value) => value.charCodeAt(0))

          void writer.write(
            message.packet.kind === 'configuration'
              ? {
                  type: 'configuration',
                  data,
                }
              : {
                  type: 'data',
                  data,
                  keyframe: message.packet.keyframe,
                  pts: message.packet.pts ? BigInt(message.packet.pts) : undefined,
                },
          )
          break
        }
      }
    })

    return () => {
      socket.close()
    }
  }, [appendLog, createDecoder, disposeDecoder])

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

  const sendMessage = useCallback((payload: object) => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      appendLog('浏览器还没有连接到控制服务。')
      return
    }

    socket.send(JSON.stringify(payload))
  }, [appendLog])

  const handleConnect = useCallback((serial?: string) => {
    const nextSerial = serial || selectedSerial

    if (!nextSerial) {
      appendLog('请先选择一台设备。')
      return
    }

    setSelectedSerial(nextSerial)
    setSession((current) => ({ ...current, state: 'connecting' }))
    sendMessage({ type: 'connect-device', serial: nextSerial })
  }, [appendLog, selectedSerial, sendMessage])

  const handleDisconnect = useCallback(() => {
    sendMessage({ type: 'disconnect-device' })
    setSession({ state: 'idle' })
    void disposeDecoder()
  }, [disposeDecoder, sendMessage])

  const sendTouch = useCallback((event: PointerEvent<HTMLCanvasElement>, action: number) => {
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
      Math.min(screenSizeRef.current.width, Math.round(((event.clientX - rect.left) / rect.width) * screenSizeRef.current.width)),
    )
    const y = Math.max(
      0,
      Math.min(screenSizeRef.current.height, Math.round(((event.clientY - rect.top) / rect.height) * screenSizeRef.current.height)),
    )

    sendMessage({
      type: 'touch',
      action,
      pointerX: x,
      pointerY: y,
      videoWidth: screenSizeRef.current.width,
      videoHeight: screenSizeRef.current.height,
    })
  }, [sendMessage])

  const handleTextSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!typedText.trim()) {
      return
    }

    sendMessage({ type: 'send-text', text: typedText })
    setTypedText('')
  }, [sendMessage, typedText])

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
        return '正在启动镜像'
      case 'error':
        return '连接异常'
      default:
        return '就绪'
    }
  }, [session.state, socketReady])

  const canControl = session.state === 'connected'

  return (
    <main className="app-shell">
      <section className="sidebar">
        <div className="panel panel-heading">
          <div>
            <p className="eyebrow">共享版 Web Scrcpy</p>
            <h1>安卓控制台</h1>
          </div>
          <span className={`status-pill ${statusTone}`}>{statusText}</span>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">设备列表</label>
            <div className="panel-actions">
              <span className="inline-note">自动搜寻中</span>
              <button type="button" className="ghost-button" onClick={() => sendMessage({ type: 'refresh-devices' })}>
                刷新
              </button>
            </div>
          </div>
          <div className="device-card-grid">
            {devices.length === 0 ? (
              <div className="empty-card">
                <strong>还没有发现设备</strong>
                <p className="hint">请连接手机并确认 USB 调试授权，列表会自动刷新。</p>
              </div>
            ) : (
              devices.map((device) => {
                const isActive = session.serial === device.serial && canControl
                const isSelected = selectedSerial === device.serial
                const canStart = socketReady && device.state === 'device' && session.state !== 'connecting'

                return (
                  <article
                    key={device.serial}
                    className={`device-card${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
                  >
                    <button
                      type="button"
                      className="device-card-hitbox"
                      onClick={() => setSelectedSerial(device.serial)}
                    >
                      <div className="device-card-head">
                        <strong>{(device.model || device.serial).trim()}</strong>
                        <span className={`device-badge ${device.state}`}>{DEVICE_STATE_LABEL[device.state]}</span>
                      </div>
                      <div className="device-meta">{device.serial}</div>
                      <div className="device-card-foot">
                        <span className="device-role">
                          {isActive ? '当前镜像设备' : isSelected ? '已选中' : '点击可切换'}
                        </span>
                        <span className="device-cta">
                          {isActive ? '已连接' : device.state === 'device' ? '可连接' : '等待授权'}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="primary-button device-connect"
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
          <div className="stack section-gap">
            <div className="device-row">
              <strong>{session.name || selectedDevice?.model || '当前没有活动镜像'}</strong>
              <span className="inline-note">{availableDevices.length} 台可连接</span>
            </div>
            <p className="hint">
              这一版由服务端统一连接手机，所以打开这个网页的人都能看到并控制同一台设备。
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-bar">
            <label className="field-label">连接设置</label>
            <span className="inline-note">通用参数</span>
          </div>
          <div className="settings-stack">
            <div className="setting-block">
              <div className="setting-head">
                <strong>码率 (Mbps)</strong>
                <span className="setting-value">当前：{bitRate} Mbps</span>
              </div>
              <div className="segmented-row">
                {[2, 4, 8, 12].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`segment-button${bitRate === value ? ' active' : ''}`}
                    onClick={() => setBitRate(value)}
                  >
                    {value} Mbps
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={bitRate}
                onChange={(event) => setBitRate(Number(event.target.value))}
              />
              <div className="range-labels">
                <span>1 Mbps</span>
                <span>20 Mbps</span>
              </div>
            </div>

            <div className="setting-block">
              <div className="setting-head">
                <strong>FPS (帧率)</strong>
                <span className="setting-value">当前：{fps} FPS</span>
              </div>
              <div className="segmented-row">
                {[24, 30, 45, 60].map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`segment-button${fps === value ? ' active' : ''}`}
                    onClick={() => setFps(value)}
                  >
                    {value} FPS
                  </button>
                ))}
              </div>
              <input
                type="range"
                min={15}
                max={60}
                step={1}
                value={fps}
                onChange={(event) => setFps(Number(event.target.value))}
              />
              <div className="range-labels">
                <span>15 FPS</span>
                <span>60 FPS</span>
              </div>
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
            <button type="button" className="ghost-button" onClick={() => setLogLines([])}>
              清空
            </button>
          </div>
          <div className="log-list" aria-live="polite">
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
        <div className="stage-header">
          <div>
            <p className="eyebrow">镜像画面</p>
            <h2>共享实时画面</h2>
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
              <span>{socketReady ? '请选择设备并启动镜像。' : '正在等待控制服务。'}</span>
            </div>
          )}
        </div>

        <div className="panel">
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
              息屏
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
