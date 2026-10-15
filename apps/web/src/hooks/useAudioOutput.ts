// useAudioOutput — Web Audio API 播放来自宿主的系统音频

import { useRef, useCallback } from 'react'

/** base64 PCM (Int16) → Float32 解码 */
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
}

export function useAudioOutput(): AudioOutputReturn {
  const ctxRef = useRef<AudioContext | null>(null)

  const play = useCallback((base64Data: string, sampleRate: number) => {
    // 延迟创建 AudioContext（需用户交互后）
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext({ sampleRate })
    }
    const ctx = ctxRef.current

    if (ctx.state === 'suspended') {
      void ctx.resume()
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
    // 立即播放，不排队——低延迟 > 无裂音
    source.start()
  }, [])

  return { play }
}