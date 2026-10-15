// useAudioOutput — Web Audio API 播放来自宿主的系统音频

import { useRef, useCallback } from 'react'
import { LOOPBACK_SAMPLE_RATE } from '@vow/shared/constants'

/** 预滚缓冲（秒）：新 chunk 到达时至少推迟这么多再播，吸收网络抖动 */
const PREROLL_S = 0.08
/** 调度领先上限（秒）：超过则重置，防止延迟无限累积 */
const MAX_SCHEDULE_AHEAD_S = 0.35

/** base64 PCM (Int16 interleaved stereo) → Float32 交错解码 */
function decodePCM(base64: string): Float32Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const int16 = new Int16Array(bytes.buffer)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 32768 : 32767)
  }
  return float32
}

interface AudioOutputReturn {
  play: (base64Data: string, sampleRate: number) => void
  /** 在用户手势（点击输出开关 / 连接按钮）中调用——解锁移动端 AudioContext。
   *  移动浏览器要求 AudioContext 在手势上下文内创建/resume，否则永远 suspended，听不到声音 */
  unlock: () => void
}

export function useAudioOutput(): AudioOutputReturn {
  const ctxRef = useRef<AudioContext | null>(null)
  const nextTimeRef = useRef(0)

  const ensureCtx = useCallback((sampleRate?: number): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate: sampleRate ?? LOOPBACK_SAMPLE_RATE })
    }
    return ctxRef.current
  }, [])

  const unlock = useCallback(() => {
    const ctx = ensureCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    // 播放 1 帧静音：部分移动浏览器要求真实播放过一次才完成解锁
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.start()
    } catch { /* noop */ }
  }, [ensureCtx])

  const play = useCallback((base64Data: string, sampleRate: number) => {
    const ctx = ensureCtx(sampleRate)
    if (ctx.state !== 'running') {
      // 未解锁（无手势）——此时 resume 无效，丢弃并等待 unlock
      return
    }

    const pcm = decodePCM(base64Data)
    const frames = Math.floor(pcm.length / 2) // stereo
    if (frames === 0) return

    const buffer = ctx.createBuffer(2, frames, sampleRate)
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    for (let i = 0; i < frames; i++) {
      left[i] = pcm[i * 2]
      right[i] = pcm[i * 2 + 1]
    }

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)

    // 排队调度：chunk 接在已调度尾部播放；欠载时以 PREROLL 重置；
    // 调度领先过多时也重置，避免延迟累积。立即 start() 会在每个
    // chunk 边界产生咔哒声/断续（网络抖动直接映射为爆音）
    const now = ctx.currentTime
    if (nextTimeRef.current < now + 0.005 || nextTimeRef.current > now + MAX_SCHEDULE_AHEAD_S) {
      nextTimeRef.current = now + PREROLL_S
    }
    source.start(nextTimeRef.current)
    nextTimeRef.current += frames / sampleRate
  }, [ensureCtx])

  return { play, unlock }
}
