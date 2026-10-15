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
  private inputDeviceName: string | null = null
  private outputDeviceId: number | null = null
  private inputActive = false
  private outputActive = false
  private inputStream: NaudiAudioIO | null = null
  private inputTimer: ReturnType<typeof setInterval> | null = null
  private outputCapture: LoopbackCaptureInstance | null = null
  private ringBuffer = new RingBuffer(INPUT_RING_BUFFER_SAMPLES)
  private outputCallback: ((buf: Buffer) => void) | null = null
  /** 上次输入流打开失败的时间戳——失败后 1s 内不重试，防止按 chunk 刷屏 */
  private lastInputFailAt = 0

  // ─── 公开 API ───

  getDeviceStatus(): AudioDeviceStatus {
    return {
      virtualInputAvailable: this.inputDeviceId !== null,
      virtualOutputAvailable: this.outputDeviceId !== null,
      inputDeviceName: this.inputDeviceId !== null ? (this.inputDeviceName ?? `VB-Cable #${this.inputDeviceId}`) : null,
      outputDeviceName: this.outputDeviceId !== null ? 'WASAPI Loopback' : null,
      inputActive: this.inputActive,
      outputActive: this.outputActive,
      installStatus: this.inputDeviceId !== null ? 'installed' : 'not_installed',
      installError: this.inputDeviceId !== null ? null : '请运行 pnpm -w run get-driver 安装 VB-Cable 驱动',
    }
  }

  start(): void {
    const n = naudi()
    console.log('[VirtualAudio] scanning devices...')

    const dev = this.findCableDevice(n)
    if (dev) {
      this.inputDeviceId = dev.id
      this.inputDeviceName = dev.name
      console.log(`[VirtualAudio] Virtual input: "${dev.name}" (id=${dev.id})`)
    } else {
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
    if (float32.length === 0) return
    // 手机实际采样率常为 48000，而 AudioIO 固定 44100 —— 必须重采样，
    // 否则麦克风声音会被拉慢约 8.8% 并降调
    const resampled = this.resampleTo44k(float32, data.sampleRate || 44100)
    this.ringBuffer.write(resampled)
    // 失败退避：上次打开失败 1s 内不重试（否则每个音频块都会刷一条错误）
    if (
      !this.inputActive &&
      this.ringBuffer.available > 1024 &&
      Date.now() - this.lastInputFailAt > 1000
    ) {
      this.startInput()
    }
  }

  /** 线性插值重采样 → 44100Hz */
  private resampleTo44k(input: Float32Array, from: number): Float32Array {
    if (from === 44100 || input.length === 0) return input
    const ratio = from / 44100
    const outLen = Math.max(1, Math.floor(input.length / ratio))
    const out = new Float32Array(outLen)
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio
      const i0 = Math.floor(pos)
      const frac = pos - i0
      const a = input[i0] ?? 0
      const b = input[i0 + 1] ?? a
      out[i] = a + (b - a) * frac
    }
    return out
  }

  /** 扫描 VB-Cable 渲染端点。
   *  必须至少 2 个输出声道——写入的是交错立体声，单声道端点会损坏音频
   *  （实测 "CABLE Input" 端点无双通道不可用，"CABLE In 16ch" 才有）。
   *  多候选时优先恰好 2 声道的端点，其次取声道数最接近 2 的。 */
  private findCableDevice(n: NaudiModule): NaudiDevice | null {
    const candidates = n.getDevices().filter(
      (d) =>
        d.name.toUpperCase().includes(VB_CABLE_KEYWORD) &&
        d.maxOutputChannels >= 2 &&
        d.hostAPIName === 'Windows WASAPI',
    )
    if (candidates.length === 0) return null
    candidates.sort((a, b) => Math.abs(a.maxOutputChannels - 2) - Math.abs(b.maxOutputChannels - 2))
    return candidates[0]
  }

  private startInput(): void {
    if (!this.inputDeviceId || this.inputActive) return
    if (this.openInputStream()) return

    // 打开失败：PortAudio 的设备枚举可能已漂移（tsx watch 硬杀进程后
    // WASAPI 端点会重枚举，缓存的 id 失效报 "Invalid device"）——重扫重试一次
    const n = naudi()
    const dev = this.findCableDevice(n)
    if (dev && dev.id !== this.inputDeviceId) {
      console.warn(`[VirtualAudio] device drift: #${this.inputDeviceId} -> #${dev.id} ("${dev.name}") — retrying`)
      this.inputDeviceId = dev.id
      this.inputDeviceName = dev.name
      if (this.openInputStream()) return
    }
    // 仍失败：记录退避时间戳，1s 后才允许再次尝试
    this.lastInputFailAt = Date.now()
  }

  private openInputStream(): boolean {
    if (this.inputDeviceId === null) return false
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

      // 必须监听 error 事件——未处理的 'error' 会直接崩溃整个进程
      stream.on('error', (err: unknown) => {
        console.error('[VirtualAudio] input stream error:', String(err))
        this.stopInput()
        this.lastInputFailAt = Date.now()
      })

      stream.start()
      this.inputActive = true

      // 定时推送：每 ~23ms 从环形缓冲取 1024 个单声道样本（1024/44100 ≈ 23.2ms，
      // 与手机音频产率 44100 samples/s 匹配），复制为 2048 帧交错立体声写入声卡。
      // 注意：AudioIO 是 2ch interleaved，若直接写单声道样本会被当作 L/R 交错导致音频损坏
      const MONO_CHUNK = 1024
      let idleTicks = 0
      this.inputTimer = setInterval(() => {
        if (!this.inputActive || !this.inputStream) return
        const mono = new Float32Array(MONO_CHUNK)
        const read = this.ringBuffer.read(mono)
        // 未读满的用静音填充
        for (let i = read; i < MONO_CHUNK; i++) mono[i] = 0
        const stereo = new Float32Array(MONO_CHUNK * 2)
        for (let i = 0; i < MONO_CHUNK; i++) {
          stereo[i * 2] = mono[i]
          stereo[i * 2 + 1] = mono[i]
        }
        try {
          this.inputStream.write(Buffer.from(stereo.buffer))
        } catch { /* stream closed */ }
        // 空闲检测：连续 ~60 tick（约 1.4s）无新数据则关闭设备，
        // 释放 CABLE（否则虚拟麦克风永远显示"使用中"）；新数据到达会自动重启
        idleTicks = read < MONO_CHUNK / 4 ? idleTicks + 1 : 0
        if (idleTicks > 60) {
          console.log('[VirtualAudio] input idle — releasing VB-Cable device')
          this.stopInput()
        }
      }, 23)

      console.log('[VirtualAudio] input stream -> VB-Cable (44100Hz float32 stereo, 23ms timer)')
      return true
    } catch (err) {
      console.error('[VirtualAudio] input open failed:', err instanceof Error ? err.message : err)
      this.lastInputFailAt = Date.now()
      return false
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

      // 排除自身进程树的环回：抓默认设备混音，但排除本进程渲染的音频。
      // 若不排除，当默认播放设备 == CABLE In（手机麦克风的写入端）时，
      // 麦克风音频会被 loopback 抓回并发给手机，形成"耳返"数字回环。
      capture.start(process.pid, false, (chunk: Buffer) => {
        if (this.outputCallback) {
          this.outputCallback(chunk)
        }
      })

      this.outputActive = true
      console.log('[VirtualAudio] output capture started (WASAPI loopback, self-excluded)')
    } catch (err) {
      // 排除模式失败时退回系统级捕获
      try {
        const capture = new LC()
        this.outputCapture = capture
        capture.startSystemAudio((chunk: Buffer) => {
          if (this.outputCallback) {
            this.outputCallback(chunk)
          }
        })
        this.outputActive = true
        console.warn('[VirtualAudio] process-excluded loopback failed, fell back to system audio:', String(err))
        console.warn('[VirtualAudio] WARNING: 默认播放设备若为 CABLE In 会出现耳返回环')
      } catch (err2) {
        console.error('[VirtualAudio] output start failed:', err2)
      }
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