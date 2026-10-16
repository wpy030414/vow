// App.tsx — vow 主界面：连接 → 录音 → 实时音量 + 虚拟音频

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSSE } from './hooks/useSSE'
import { useMicrophone } from './hooks/useMicrophone'
import { useAudioOutput } from './hooks/useAudioOutput'
import { syncAudioSession } from './lib/audio-route'
import { MicButton } from './components/MicButton'
import { ControlBar } from './components/ControlBar'
import { VolumeIndicator } from './components/VolumeIndicator'
import { PairingScreen } from './components/PairingScreen'
import { WifiOff } from 'lucide-react'
import { cn } from './lib/utils'
import type { RecordMode, AudioDeviceStatus } from '@vow/shared/types'

/** 三开关的本地持久化 key（录制模式 / 播放设备 / 转文字） */
const MODE_STORAGE_KEY = 'vow.record-mode'
const OUTPUT_STORAGE_KEY = 'vow.output-enabled'
const DICTATION_STORAGE_KEY = 'vow.dictation-enabled'

/** 读取持久化值（隐私模式等场景静默返回 null） */
function loadStored(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** 写入持久化值（失败静默） */
function store(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* 隐私模式等场景 */ }
}

export function App() {
  const [mode, setMode] = useState<RecordMode>(() => (loadStored(MODE_STORAGE_KEY) === 'hold' ? 'hold' : 'tap'))
  const [isOutputEnabled, setOutputEnabled] = useState<boolean>(() => loadStored(OUTPUT_STORAGE_KEY) === '1')
  const [dictationEnabled, setDictationEnabled] = useState<boolean>(() => loadStored(DICTATION_STORAGE_KEY) === '1')
  const [deviceStatus, setDeviceStatus] = useState<AudioDeviceStatus | null>(null)
  /** ?t= 配对尝试的错误提示（展示于配对引导屏） */
  const [pairError, setPairError] = useState<string | null>(null)

  // Web Audio 输出播放器
  const { play: playOutputAudio, unlock: unlockOutputAudio, setKeepAlive, refreshSink } = useAudioOutput()

  // output_audio 回调
  const onOutputAudio = useCallback((base64Data: string, sampleRate: number) => {
    playOutputAudio(base64Data, sampleRate)
  }, [playOutputAudio])

  // SSE 会话（自动连接，无手动断开入口）
  const { sessionId, connected, connecting, unauthorized, connect, uploadAudio, updateState } = useSSE({
    deviceName: 'vow-client',
    mode,
    onOutputAudio,
  })

  // 查询设备状态（连接后）
  useEffect(() => {
    if (!connected) return
    fetch('/api/audio/devices')
      .then((r) => r.json())
      .then((d: { status: AudioDeviceStatus }) => setDeviceStatus(d.status))
      .catch(() => {})
  }, [connected])

  // 打开页面即自动连接——SSE 会话本身无需用户手势；
  // 手势只用于解锁音频（麦克风权限弹窗、输出 AudioContext）
  // 若 URL 携带配对令牌（?t=，来自 pnpm pair 二维码）：先配对，再连接
  const didAutoConnectRef = useRef(false)
  useEffect(() => {
    if (didAutoConnectRef.current) return
    didAutoConnectRef.current = true
    void (async () => {
      const t = new URLSearchParams(window.location.search).get('t')
      if (t) {
        try {
          const resp = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: t }),
          })
          if (!resp.ok) setPairError('配对令牌无效或已轮换——请在宿主机重新运行 pnpm pair 后扫码')
        } catch {
          setPairError('配对请求失败——请确认宿主机服务在运行')
        }
        // 无论成败都抹掉地址栏中的令牌（防截图/书签同步泄漏）
        window.history.replaceState(null, '', window.location.pathname)
      }
      void connect()
    })()
  }, [connect])

  // 三开关持久化：统一 effect 写入（收口全部变更路径，含失败回退）
  useEffect(() => { store(MODE_STORAGE_KEY, mode) }, [mode])
  useEffect(() => { store(OUTPUT_STORAGE_KEY, isOutputEnabled ? '1' : '0') }, [isOutputEnabled])
  useEffect(() => { store(DICTATION_STORAGE_KEY, dictationEnabled ? '1' : '0') }, [dictationEnabled])

  // 「播放设备」持久化恢复：新会话在服务端默认关闭——建立后补同步一次。
  // 不在此处 unlock 播放（无手势）：未解锁时音频到达会被丢弃，首次触摸由既有
  // pointerdown 解锁逻辑接管，随后自动恢复播放
  const syncedOutputRef = useRef<string | null>(null)
  useEffect(() => {
    if (!connected || !sessionId) return
    if (syncedOutputRef.current === sessionId) return
    syncedOutputRef.current = sessionId
    if (!isOutputEnabled) return
    fetch(`/api/audio/output?sessionId=${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }).catch(() => {})
  }, [connected, sessionId, isOutputEnabled])

  // 任意首次触摸/点击都解锁输出播放（移动端自动播放策略；
  // 覆盖"自动连接后直接按麦克风"等所有路径）
  useEffect(() => {
    const h = () => unlockOutputAudio()
    document.addEventListener('pointerdown', h, { once: true })
    return () => document.removeEventListener('pointerdown', h)
  }, [unlockOutputAudio])

  // 麦克风
  const onAudioData = useCallback(
    async (data: string, sampleRate: number, sequence: number) => {
      try {
        await uploadAudio(data, sampleRate, sequence)
      } catch { /* network glitch */ }
    },
    [uploadAudio],
  )

  const { recording, audioLevel, error: micError, startRecording, stopRecording } = useMicrophone({ onAudioData })

  // 后台保活：录音中（Tap 持续态）或播放开启期间维持静默循环音源——
  // 「正在播放音频」标记令浏览器豁免后台冻结，配合「采集中」豁免实现后台续传
  useEffect(() => {
    setKeepAlive(recording || isOutputEnabled)
  }, [recording, isOutputEnabled, setKeepAlive])

  // 输出路由：录音中 / 输出开启时把移动端音频会话切到扬声器（不切则一旦用过麦克风，
  // 输出会被 iOS 锁在通话模式的「听筒」上）；两者皆否时交还浏览器自动判定
  useEffect(() => {
    syncAudioSession(recording, isOutputEnabled)
  }, [recording, isOutputEnabled])

  // 麦克风授权后设备标签才可见——授权瞬间重挑一次扬声器输出设备（Android setSinkId）
  useEffect(() => {
    if (recording) refreshSink()
  }, [recording, refreshSink])

  // 录音状态变化 → 同步服务端（听写联动：仅 hold 模式 + 「转文字」开启 + 录音中激活）
  useEffect(() => {
    if (!sessionId) return
    const dictationActive = recording && dictationEnabled && mode === 'hold'
    updateState({ recording, audioLevel, dictation: dictationActive }).catch(() => {})
  }, [recording, sessionId, updateState, dictationEnabled, mode])

  // 模式切换
  const handleModeChange = useCallback((newMode: RecordMode) => {
    if (recording) stopRecording()
    setMode(newMode)
    if (sessionId) { updateState({ mode: newMode }).catch(() => {}) }
  }, [recording, stopRecording, sessionId, updateState])

  // 输出设备开关 → 后端 API
  const handleToggleOutput = useCallback(async (on: boolean) => {
    // 在手势内解锁输出 AudioContext（移动端要求，否则听不到声音）
    if (on) unlockOutputAudio()
    setOutputEnabled(on)
    if (!sessionId) return
    try {
      await fetch(`/api/audio/output?sessionId=${sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: on }),
      })
    } catch { setOutputEnabled(!on) }
  }, [sessionId, unlockOutputAudio])

  // 「转文字」开关——生效条件在上方 effect 中计算（hold + 录音中）；持久化由统一 effect 承担
  const handleToggleDictation = useCallback((on: boolean) => {
    setDictationEnabled(on)
  }, [])

  // 未配对：整个界面让位给配对引导屏
  if (unauthorized) {
    return (
      <PairingScreen
        error={pairError}
        onRetry={() => {
          setPairError(null)
          void connect()
        }}
      />
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 w-full max-w-sm px-6">
        <div className="text-center select-none">
          <h1 className="text-3xl font-bold tracking-tight">vow</h1>
          <p className="text-sm text-muted-foreground mt-1">Voice over Web</p>
        </div>

        {/* 自动连接中 / 失败——极简轻量状态，不再是独立初始页 */}
        {!connected && (
          <div className="flex flex-col items-center gap-4 py-16">
            {connecting ? (
              <div className="text-sm text-muted-foreground animate-pulse">连接宿主机中…</div>
            ) : (
              <>
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <WifiOff className="w-4 h-4" />
                  <span>未连接</span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    unlockOutputAudio()
                    void connect()
                  }}
                  className={cn(
                    'px-6 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    'bg-primary text-primary-foreground hover:bg-primary/90',
                  )}
                >
                  重试连接
                </button>
              </>
            )}
          </div>
        )}

        {connected && (
          <>
            <ControlBar
              mode={mode}
              onModeChange={handleModeChange}
              modeDisabled={recording}
              outputEnabled={isOutputEnabled}
              onOutputChange={handleToggleOutput}
              dictationEnabled={dictationEnabled}
              onDictationChange={handleToggleDictation}
              dictationDisabled={recording || mode !== 'hold'}
            />

            <div className="pt-4">
              <MicButton
                mode={mode}
                recording={recording}
                audioLevel={audioLevel}
                disabled={!connected}
                onStart={startRecording}
                onStop={stopRecording}
              />
            </div>

            <div className="pt-6">
              <VolumeIndicator level={audioLevel} recording={recording} />
            </div>

            {/* VB-Cable 安装状态 */}
            {deviceStatus && (
              <>
                {deviceStatus.installStatus === 'installing' && (
                  <div className="text-xs text-muted-foreground text-center bg-muted/50 rounded-lg px-4 py-2 animate-pulse">
                    正在安装虚拟音频设备…
                  </div>
                )}
                {deviceStatus.installStatus === 'failed' && (
                  <div className="text-xs text-destructive text-center bg-destructive/10 rounded-lg px-4 py-2">
                    {deviceStatus.installError || '虚拟音频设备安装失败'}
                  </div>
                )}
                {deviceStatus.installStatus === 'not_installed' && !deviceStatus.virtualInputAvailable && (
                  <div className="text-xs text-muted-foreground text-center bg-muted/50 rounded-lg px-4 py-2">
                    {deviceStatus.installError
                      ? `虚拟麦克风不可用——${deviceStatus.installError}`
                      : '虚拟麦克风不可用'}
                  </div>
                )}
              </>
            )}

            {micError && (
              <div className="text-sm text-destructive text-center bg-destructive/10 rounded-lg px-4 py-2">
                {micError}
              </div>
            )}

            {/* 原"断开连接"位置：完整会话 ID */}
            {sessionId && (
              <div className="text-xs text-muted-foreground font-mono text-center select-all break-all">
                {sessionId}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}