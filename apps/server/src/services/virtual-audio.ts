// VirtualAudioManager — 虚拟音频输入/输出设备管理
// 输入：手机 PCM (SSE) → RingBuffer → naudiodon AudioIO → VB-Cable → 桌面应用
// 输出：WASAPI loopback → loopback-capture → SSE → 手机

import type { AudioDeviceStatus } from '@vow/shared/types'
import { INPUT_RING_BUFFER_SAMPLES, VB_CABLE_KEYWORD } from '@vow/shared/constants'

// 类型声明：无 TS 类型的原生模块
// 放在单独 .d.ts 中以避免块级重声明问题

// 内联类型：naudiodon 相关
interface NaudiDevice {
  id: number; name: string; maxInputChannels: number; maxOutputChannels: number; hostAPIName: string
}
interface NaudiModule {
  SampleFormatFloat32: number
  getDevices(): NaudiDevice[]
  AudioIO(opts: { outOptions: { channelCount: number; sampleFormat: number; sampleRate: number; deviceId?: number; closeOnError?: boolean } }): NaudiAudioIO
}
interface NaudiAudioIO {
  start(): void; quit(): void; abort(): void
  on(event: string, cb: (...args: unknown[]) => void): this
  write(chunk: Buffer | string, cb?: (err?: Error | null) => void): boolean
}

// 内联类型：loopback-capture 相关
interface LoopbackCaptureInstance {
  start(pid: number, includeTree: boolean, cb: (chunk: Buffer) => void): void
  startSystemAudio(cb: (chunk: Buffer) => void): void
  stop(): void
}
interface LoopbackCaptureModule {
  LoopbackCapture: new () => LoopbackCaptureInstance
  path: string
}

// ─── 动态加载 ───

import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)

let _naudiodon: NaudiModule | null = null
function naudi(): NaudiModule {
  if (!_naudiodon) {
    _naudiodon = req('@gpeng/naudiodon') as NaudiModule
    console.log('[VirtualAudio] @gpeng/naudiodon loaded')
  }
  return _naudiodon
}

let _LoopbackCaptureCtor: (new () => LoopbackCaptureInstance) | null = null
function lcCtor(): new () => LoopbackCaptureInstance {
  if (!_LoopbackCaptureCtor) {
    const mod = req('loopback-capture') as LoopbackCaptureModule
    _LoopbackCaptureCtor = mod.LoopbackCapture
    console.log('[VirtualAudio] loopback-capture loaded')
  }
  return _LoopbackCaptureCtor
}

// ─── 环形缓冲 ───

class RingBuffer {
  private buf: Float32Array
  private writePos = 0
  private readPos = 0
  private _available = 0

  constructor(size: number) {
    this.buf = new Float32Array(size)
  }

  get available(): number { return this._available }
  get capacity(): number { return this.buf.length }

  write(data: Float32Array): void {
    for (let i = 0; i < data.length; i++) {
      this.buf[this.writePos] = data[i]
      this.writePos = (this.writePos + 1) % this.buf.length
      if (this._available < this.buf.length) {
        this._available++
      } else {
        this.readPos = (this.readPos + 1) % this.buf.length
      }
    }
  }

  read(out: Float32Array): number {
    let read = 0
    while (read < out.length && this._available > 0) {
      out[read++] = this.buf[this.readPos]
      this.readPos = (this.readPos + 1) % this.buf.length
      this._available--
    }
    return read
  }

  clear(): void {
    this.writePos = 0
    this.readPos = 0
    this._available = 0
  }
}

// ─── PCM 工具 ───

function base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64)
  // PCM 数据必须是 16-bit 整数——跳过短于 2 字节的块
  if (binary.length < 2) return new Float32Array(0)
  // 确保偶数长度（丢弃可能的最后一个单字节）
  const len = binary.length - (binary.length % 2)
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i)
  const int16 = new Int16Array(bytes.buffer)
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / (int16[i] < 0 ? 32768 : 32767)
  }
  return float32
}

// ─── 主类 ───

export class VirtualAudioManager {
  private inputDeviceId: number | null = null
  private outputDeviceId: number | null = null
  private inputActive = false
  private outputActive = false
  private inputStream: NaudiAudioIO | null = null
  private inputTimer: ReturnType<typeof setInterval> | null = null
  private outputCapture: LoopbackCaptureInstance | null = null
  private ringBuffer = new RingBuffer(INPUT_RING_BUFFER_SAMPLES)
  private outputCallback: ((buf: Buffer) => void) | null = null

  // ─── 公开 API ───

  getDeviceStatus(): AudioDeviceStatus {
    return {
      virtualInputAvailable: this.inputDeviceId !== null,
      virtualOutputAvailable: this.outputDeviceId !== null,
      inputDeviceName: this.inputDeviceId !== null ? `VB-Cable #${this.inputDeviceId}` : null,
      outputDeviceName: this.outputDeviceId !== null ? 'WASAPI Loopback' : null,
      inputActive: this.inputActive,
      outputActive: this.outputActive,
      installStatus: this.inputDeviceId !== null ? 'installed' : 'not_installed',
      installError: this.inputDeviceId !== null ? null : '请运行 pnpm -w run get-driver 安装 VB-Cable 驱动',
    }
  }

  start(): void {
    const n = naudi()
    const devices = n.getDevices()

    console.log('[VirtualAudio] scanning devices...')

    for (const dev of devices) {
      if (
        dev.name.toUpperCase().includes(VB_CABLE_KEYWORD) &&
        dev.maxOutputChannels > 0 &&
        dev.hostAPIName === 'Windows WASAPI'
      ) {
        this.inputDeviceId = dev.id
        console.log(`[VirtualAudio] Virtual input: "${dev.name}" (id=${dev.id})`)
        break
      }
    }

    if (!this.inputDeviceId) {
      console.warn('[VirtualAudio] VB-Cable not found — virtual mic unavailable')
      console.warn('[VirtualAudio] run: pnpm -w run get-driver (as Administrator)')
    }

    // 验证 loopback 可用性
    try {
      const LC = lcCtor()
      const probe = new LC()
      probe.stop()
      this.outputDeviceId = -1
      console.log('[VirtualAudio] WASAPI loopback available')
    } catch (err) {
      console.warn('[VirtualAudio] WASAPI loopback unavailable:', String(err))
    }

    console.log('[VirtualAudio] status:', this.getDeviceStatus())
  }

  stop(): void {
    this.stopInput()
    this.stopOutput()
    this.ringBuffer.clear()
    console.log('[VirtualAudio] stopped')
  }

  // ─── 输入链路：手机 PCM → RingBuffer → VB-Cable ───

  writeInputPCM(data: { data: string; sampleRate: number }): void {
    if (!this.inputDeviceId) return
    const float32 = base64ToFloat32(data.data)
    this.ringBuffer.write(float32)
    if (!this.inputActive && this.ringBuffer.available > 1024) {
      this.startInput()
    }
  }

  private startInput(): void {
    if (!this.inputDeviceId || this.inputActive) return
    const n = naudi()

    try {
      const stream = n.AudioIO({
        outOptions: {
          channelCount: 2,
          sampleFormat: n.SampleFormatFloat32,
          sampleRate: 44100,
          deviceId: this.inputDeviceId,
          closeOnError: true,
        },
      })

      this.inputStream = stream
      stream.start()
      this.inputActive = true

      // 定时推送：每 ~23ms 从环形缓冲取 1024 样本写入声卡
      // 1024 / 44100 ≈ 23.2ms —— 保持低延迟且不欠载
      const CHUNK = 1024
      this.inputTimer = setInterval(() => {
        if (!this.inputActive || !this.inputStream) return
        const out = new Float32Array(CHUNK)
        const read = this.ringBuffer.read(out)
        // 未读满的用静音填充
        for (let i = read; i < CHUNK; i++) out[i] = 0
        try {
          this.inputStream.write(Buffer.from(out.buffer))
        } catch { /* stream closed */ }
      }, 23)

      console.log('[VirtualAudio] input stream -> VB-Cable (44100Hz float32 stereo, 23ms timer)')
    } catch (err) {
      console.error('[VirtualAudio] input start failed:', err)
    }
  }

  private stopInput(): void {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = null }
    if (this.inputStream) {
      try { this.inputStream.quit() } catch { /* noop */ }
      this.inputStream = null
    }
    this.inputActive = false
    this.ringBuffer.clear()
    console.log('[VirtualAudio] input stopped')
  }

  // ─── 输出链路：WASAPI loopback → 手机 ───

  setOutputCallback(cb: ((buf: Buffer) => void) | null): void {
    this.outputCallback = cb
  }

  startOutput(): void {
    if (!this.outputDeviceId || this.outputActive) return
    const LC = lcCtor()

    try {
      const capture = new LC()
      this.outputCapture = capture

      capture.startSystemAudio((chunk: Buffer) => {
        if (this.outputCallback) {
          this.outputCallback(chunk)
        }
      })

      this.outputActive = true
      console.log('[VirtualAudio] output capture started (WASAPI loopback)')
    } catch (err) {
      console.error('[VirtualAudio] output start failed:', err)
    }
  }

  stopOutput(): void {
    if (this.outputCapture) {
      try { this.outputCapture.stop() } catch { /* noop */ }
      this.outputCapture = null
    }
    this.outputActive = false
    console.log('[VirtualAudio] output stopped')
  }
}

// ─── 单例 ───

export const virtualAudio = new VirtualAudioManager()