// useMicrophone — 浏览器麦克风采集 + PCM 编码

import { useRef, useCallback, useState } from 'react'
import { DEFAULT_SAMPLE_RATE, AUDIO_BUFFER_SIZE, AUDIO_CHANNELS } from '@vow/shared/constants'

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

export function useMicrophone({ onAudioData }: UseMicrophoneOptions): UseMicrophoneReturn {
  const [recording, setRecording] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const startingRef = useRef(false)
  const sequenceRef = useRef(0)
  const callbackRef = useRef(onAudioData)
  callbackRef.current = onAudioData

  const stopRecording = useCallback(() => {
    startingRef.current = false
    // 断开 processor
    if (processorRef.current) {
      try {
        processorRef.current.disconnect()
        processorRef.current.onaudioprocess = null
      } catch { /* noop */ }
      processorRef.current = null
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
    setRecording(false)
    setAudioLevel(0)
  }, [])

  const startRecording = useCallback(async () => {
    setError(null)

    // 重入护栏：正在启动 / 已有活跃链路时先清理，杜绝泄漏的第二套 AudioContext 持续采集
    if (startingRef.current) return
    if (audioContextRef.current || streamRef.current || processorRef.current) {
      stopRecording()
    }
    startingRef.current = true

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
      streamRef.current = stream

      // 2. 创建 AudioContext（使用实际采样率）
      const audioCtx = new AudioContext({ sampleRate: stream.getAudioTracks()[0].getSettings().sampleRate ?? DEFAULT_SAMPLE_RATE })
      audioContextRef.current = audioCtx

      const actualSampleRate = audioCtx.sampleRate

      // 3. 连接：source → processor → destination（不输出到扬声器，可设 gain 0）
      const source = audioCtx.createMediaStreamSource(stream)
      const processor = audioCtx.createScriptProcessor(AUDIO_BUFFER_SIZE, AUDIO_CHANNELS, AUDIO_CHANNELS)
      processorRef.current = processor

      // 静音本地输出（避免啸叫）
      const gainNode = audioCtx.createGain()
      gainNode.gain.value = 0
      source.connect(processor)
      processor.connect(gainNode)
      gainNode.connect(audioCtx.destination)

      // 4. 处理音频帧
      processor.onaudioprocess = (evt) => {
        const inputData = evt.inputBuffer.getChannelData(0)
        const pcm16 = float32ToPCM16(inputData)
        const base64 = arrayBufferToBase64(pcm16.buffer as ArrayBuffer)
        const seq = sequenceRef.current++
        callbackRef.current(base64, actualSampleRate, seq)

        // 计算音量电平
        let sum = 0
        for (let i = 0; i < inputData.length; i++) {
          sum += Math.abs(inputData[i])
        }
        const rms = Math.sqrt(sum / inputData.length)
        setAudioLevel(Math.min(rms * 5, 1)) // 放大便于 UI 显示
      }

      setRecording(true)
      startingRef.current = false
    } catch (err) {
      const msg = err instanceof DOMException
        ? err.name === 'NotAllowedError'
          ? '麦克风权限被拒绝——主人能不能给咱开一下权限喵♪'
          : err.message
        : String(err)
      setError(msg)
      stopRecording()
    }
  }, [stopRecording])

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