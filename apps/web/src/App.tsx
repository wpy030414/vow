// App.tsx — vow 主界面：连接 → 录音 → 实时音量 + 虚拟音频

import { useState, useCallback, useEffect } from 'react'
import { useSSE } from './hooks/useSSE'
import { useMicrophone } from './hooks/useMicrophone'
import { useAudioOutput } from './hooks/useAudioOutput'
import { MicButton } from './components/MicButton'
import { ModeSelector } from './components/ModeSelector'
import { VolumeIndicator } from './components/VolumeIndicator'
import { ConnectionStatus } from './components/ConnectionStatus'
import { OutputToggle } from './components/OutputToggle'
import { cn } from './lib/utils'
import type { RecordMode, AudioDeviceStatus } from '@vow/shared/types'

export function App() {
  const [mode, setMode] = useState<RecordMode>('tap')
  const [isOutputEnabled, setOutputEnabled] = useState(false)
  const [deviceStatus, setDeviceStatus] = useState<AudioDeviceStatus | null>(null)

  // Web Audio 输出播放器
  const { play: playOutputAudio, unlock: unlockOutputAudio } = useAudioOutput()

  // output_audio 回调
  const onOutputAudio = useCallback((base64Data: string, sampleRate: number) => {
    playOutputAudio(base64Data, sampleRate)
  }, [playOutputAudio])

  // SSE 会话
  const { sessionId, connected, connecting, connect, disconnect, uploadAudio, updateState } = useSSE({
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

  // 录音状态变化 → 同步服务端
  useEffect(() => {
    if (!sessionId) return
    updateState({ recording, audioLevel }).catch(() => {})
  }, [recording, sessionId, updateState])

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

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-8 w-full max-w-sm px-6">
        <div className="text-center select-none">
          <h1 className="text-3xl font-bold tracking-tight">vow</h1>
          <p className="text-sm text-muted-foreground mt-1">Voice over Web</p>
        </div>

        {!connected && (
          <button
            type="button"
            disabled={connecting}
            onClick={() => {
              unlockOutputAudio() // 借用这次手势提前解锁输出播放
              void connect()
            }}
            className={cn(
              'w-full py-3 rounded-lg text-sm font-medium transition-colors',
              'bg-primary text-primary-foreground hover:bg-primary/90',
              connecting && 'opacity-60 animate-pulse',
            )}
          >
            {connecting ? '连接中…' : '连接宿主机'}
          </button>
        )}

        {connected && (
          <>
            <ModeSelector mode={mode} onChange={handleModeChange} disabled={recording} />

            <ConnectionStatus
              connected={connected}
              connecting={connecting}
              sessionId={sessionId}
              recording={recording}
              mode={mode}
              isOutputEnabled={isOutputEnabled}
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

            <VolumeIndicator level={audioLevel} recording={recording} />

            <OutputToggle
              enabled={isOutputEnabled}
              onChange={handleToggleOutput}
              disabled={!connected}
            />

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

            <button
              type="button"
              onClick={disconnect}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-4 transition-colors"
            >
              断开连接
            </button>
          </>
        )}
      </div>
    </div>
  )
}