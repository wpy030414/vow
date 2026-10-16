// useAudioOutput — Web Audio API 播放来自宿主的系统音频

import { useRef, useCallback, useEffect } from 'react'
import { LOOPBACK_SAMPLE_RATE } from '@vow/shared/constants'
import { preferLoudspeakerSink } from '../lib/audio-route'

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
  /** 后台保活开关：true 期间维持一个静默循环音源（见 applyKeepAlive 注释），页面豁免后台冻结 */
  setKeepAlive: (on: boolean) => void
  /** 重新挑选输出设备（扬声器）——麦克风授权后设备标签才可见，此时需再挑一次 */
  refreshSink: () => void
}

export function useAudioOutput(): AudioOutputReturn {
  const ctxRef = useRef<AudioContext | null>(null)
  const nextTimeRef = useRef(0)

  const ensureCtx = useCallback((sampleRate?: number): AudioContext => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate: sampleRate ?? LOOPBACK_SAMPLE_RATE })
      // 尽量把输出钉到扬声器（Android setSinkId 分支；iOS 由 audioSession 分支负责）
      void preferLoudspeakerSink(ctxRef.current)
    }
    return ctxRef.current
  }, [])

  /** 设备标签在麦克风授权后才可见——授权后重挑一次扬声器（Android） */
  const refreshSink = useCallback(() => {
    const ctx = ctxRef.current
    if (ctx) void preferLoudspeakerSink(ctx)
  }, [])

  // ─── 后台保活 ───

  /** 保活循环音源（1s 静音 loop）与期望态 */
  const keepAliveRef = useRef<AudioBufferSourceNode | null>(null)
  const keepAliveWantedRef = useRef(false)

  const stopKeepAlive = useCallback(() => {
    if (keepAliveRef.current) {
      try { keepAliveRef.current.stop() } catch { /* noop */ }
      keepAliveRef.current = null
    }
  }, [])

  const applyKeepAlive = useCallback(() => {
    if (!keepAliveWantedRef.current) {
      stopKeepAlive()
      return
    }
    const ctx = ctxRef.current
    if (!ctx || keepAliveRef.current) return
    // 静音循环音源：页面被标记「正在播放音频」，浏览器据此豁免后台标签冻结/
    // 重度节流（与「采集中」豁免互补，后台录音与下行播放得以持续；热路径无定时器依赖）。
    // context 挂起时 start() 合法——resume 后自动发声（静音），无需等待解锁
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.connect(ctx.destination)
    src.start()
    keepAliveRef.current = src
  }, [stopKeepAlive])

  const setKeepAlive = useCallback((on: boolean) => {
    keepAliveWantedRef.current = on
    applyKeepAlive()
  }, [applyKeepAlive])

  // 回前台恢复：移动端后台挂起（suspended/interrupted）后不自动恢复，需显式 resume
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const ctx = ctxRef.current
      if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => { /* 待下一次手势 */ })
      applyKeepAlive()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [applyKeepAlive])

  // 卸载清理：停掉保活音源
  useEffect(() => stopKeepAlive, [stopKeepAlive])

  const unlock = useCallback(() => {
    const ctx = ensureCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
    applyKeepAlive() // 保活请求可能先于 context 就绪发出——解锁时补挂
    // 播放 1 帧静音：部分移动浏览器要求真实播放过一次才完成解锁
    try {
      const buf = ctx.createBuffer(1, 1, ctx.sampleRate)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      src.start()
    } catch { /* noop */ }
  }, [ensureCtx, applyKeepAlive])

  const play = useCallback((base64Data: string, sampleRate: number) => {
    const ctx = ensureCtx(sampleRate)
    if (ctx.state !== 'running') {
      // 未解锁（无手势）或后台挂起——尝试 resume（无手势可能无效），本块丢弃
      void ctx.resume().catch(() => { /* 待下一次手势 */ })
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

  return { play, unlock, setKeepAlive, refreshSink }
}
