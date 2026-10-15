// useMicrophone — 浏览器麦克风采集 + PCM 编码（AudioWorklet，1024 采样块 ≈ 23ms）
//
// 采集链路：getUserMedia → MediaStreamAudioSourceNode → AudioWorkletNode('mic-capture')
//   → 每积满 1024 采样 post 一块（transfer 零拷贝）→ 主线程 PCM16 base64 → 上行 POST
//
// 相对 ScriptProcessor（4096 采样 ≈ 93ms 一块，A14）：
// - 采集块量化延迟 93ms → 23ms（上行延迟主项，端到端延迟减半）
// - 音频回调移至 worklet 线程——主线程渲染/长任务不再串进采集节奏
// - 摆脱已废弃 API

import { useRef, useCallback, useState, useEffect } from 'react'
import { DEFAULT_SAMPLE_RATE, CAPTURE_CHUNK_SAMPLES, AUDIO_CHANNELS } from '@vow/shared/constants'
// ?url&no-inline：强制产出外链资产文件——小文件（<4KB）默认会被 Vite 内联为
// data: URL，而 data URL 形式的 worklet 跨浏览器不可靠（addModule 的兼容性坑）
import micCaptureWorkletUrl from '../worklets/mic-capture-worklet.js?url&no-inline'

type AudioDataCallback = (data: string, sampleRate: number, sequence: number) => void

interface UseMicrophoneOptions {
  onAudioData: AudioDataCallback
}

interface UseMicrophoneReturn {
  /** 是否正在录音 */
  recording: boolean
  /** 当前音量电平 0-1 */
  audioLevel: number
  /** 是否有权限错误 */
  error: string | null
  /** 开始录音（Tap 模式 / Hold 按下） */
  startRecording: () => Promise<void>
  /** 停止录音（Tap 模式 / Hold 松开） */
  stopRecording: () => void
}

/** 电平提交间隔（ms）与 EMA 系数：AudioWorklet 每 ~23ms 出一块，逐块 setState 会让
 *  麦克风光环的 CSS 过渡反复重定目标（高频抽搐）；EMA + ~20Hz 节流后平滑跟手 */
const LEVEL_EMIT_MS = 50
const LEVEL_EMA_ALPHA = 0.3

export function useMicrophone({ onAudioData }: UseMicrophoneOptions): UseMicrophoneReturn {
  const [recording, setRecording] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const startingRef = useRef(false)
  /** start 世代令牌：每次 start/stop 递增；用于丢弃在途（如等待权限弹窗）的过期 getUserMedia 结果 */
  const startEpochRef = useRef(0)
  const sequenceRef = useRef(0)
  const callbackRef = useRef(onAudioData)
  callbackRef.current = onAudioData
  /** 电平 EMA 平滑值（原始 RMS 0-1）与上次提交时间——见 LEVEL_* 注释 */
  const levelRef = useRef(0)
  const lastLevelEmitRef = useRef(0)

  const stopRecording = useCallback(() => {
    // 作废在途 start（getUserMedia 可能在首次权限弹窗中长时间等待）
    startEpochRef.current++
    startingRef.current = false
    // 停掉 worklet 节点
    if (workletRef.current) {
      try {
        workletRef.current.port.postMessage('stop')
        workletRef.current.port.onmessage = null
        workletRef.current.disconnect()
      } catch { /* noop */ }
      workletRef.current = null
    }
    // 停止音轨
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    // 关闭 AudioContext
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
    levelRef.current = 0
    lastLevelEmitRef.current = 0
    setRecording(false)
    setAudioLevel(0)
  }, [])

  const startRecording = useCallback(async () => {
    setError(null)

    // 重入护栏：正在启动 / 已有活跃链路时先清理，杜绝泄漏的第二套 AudioContext 持续采集
    if (startingRef.current) return
    if (audioContextRef.current || streamRef.current || workletRef.current) {
      stopRecording()
    }
    startingRef.current = true
    const epoch = ++startEpochRef.current

    try {
      // 1. 获取麦克风权限
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: AUDIO_CHANNELS,
          sampleRate: DEFAULT_SAMPLE_RATE,
        },
      })
      // 等待期间已被 stop（典型：首次权限弹窗，用户已松手）→ 掐掉此流，不建立采集链路
      if (epoch !== startEpochRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream

      // 2. 创建 AudioContext（使用实际采样率）
      const audioCtx = new AudioContext({ sampleRate: stream.getAudioTracks()[0].getSettings().sampleRate ?? DEFAULT_SAMPLE_RATE })
      audioContextRef.current = audioCtx

      const actualSampleRate = audioCtx.sampleRate

      // 3. 加载 worklet 处理器（每个 AudioContext 各需一次；URL 经 Vite ?url 托管，dev/prod 同构）
      await audioCtx.audioWorklet.addModule(micCaptureWorkletUrl)
      // 加载期间被 stop → stopRecording 已清理（含本 ctx），静默退出
      if (epoch !== startEpochRef.current) return

      // 4. 连接：source → worklet → gain(0) → destination
      //（worklet 不输出声音；接向 destination 是 WebAudio 拉取式图的保活要求）
      const source = audioCtx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(audioCtx, 'mic-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [AUDIO_CHANNELS],
        channelCount: AUDIO_CHANNELS,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { chunkSize: CAPTURE_CHUNK_SAMPLES },
      })
      workletRef.current = node

      // 静音本地输出（避免啸叫）
      const gainNode = audioCtx.createGain()
      gainNode.gain.value = 0
      source.connect(node)
      node.connect(gainNode)
      gainNode.connect(audioCtx.destination)

      // 5. 处理音频块：worklet 每积满 1024 采样出一块（transfer 零拷贝）
      node.port.onmessage = (evt: MessageEvent<Float32Array>) => {
        const inputData = evt.data
        const pcm16 = float32ToPCM16(inputData)
        const base64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer)
        const seq = sequenceRef.current++
        callbackRef.current(base64, actualSampleRate, seq)

        // 音量电平：EMA 平滑 + 时间节流（43Hz 原始更新会令光环动画高频抽搐）
        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += Math.abs(inputData[i])
        }
        const rms = Math.sqrt(sum / inputData.length)
        levelRef.current = levelRef.current * (1 - LEVEL_EMA_ALPHA) + rms * LEVEL_EMA_ALPHA
        const now = performance.now()
        if (now - lastLevelEmitRef.current >= LEVEL_EMIT_MS) {
          lastLevelEmitRef.current = now
          setAudioLevel(Math.min(levelRef.current * 5, 1)) // 放大便于 UI 显示
        }
      }

      // worklet 侧异常（处理器抛出/退出）→ 收敛为错误态，不再无声失败
      node.onprocessorerror = () => {
        if (epoch !== startEpochRef.current) return
        setError('音频处理器异常——请重试')
        stopRecording()
      }

      setRecording(true)
      startingRef.current = false
    } catch (err) {
      // 已被 stop 作废的尝试：静默丢弃（权限结果留待下一次按压处理，不覆盖新状态的错误展示）
      if (epoch !== startEpochRef.current) return
      const msg = err instanceof DOMException
        ? err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝——主人能不能给咱开一下权限喵♪'
          : err.message
        : String(err)
      setError(msg)
      stopRecording()
    }
  }, [stopRecording])

  // 回前台恢复：移动端后台挂起采集 context（suspended/interrupted）后需显式 resume
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const ctx = audioContextRef.current
      if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => { /* noop */ })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  return { recording, audioLevel, error, startRecording, stopRecording }
}

// ─── 工具函数 ───

/** Float32 PCM → Int16 PCM */
function float32ToPCM16(float32Array: Float32Array): Int16Array {
  const len = float32Array.length
  const pcm16 = new Int16Array(len)
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }
  return pcm16
}

/** ArrayBuffer → Base64 字符串 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
