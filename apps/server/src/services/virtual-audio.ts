// VirtualAudioManager — 虚拟音频输入/输出设备管理
// 输入：手机 PCM (SSE) → RingBuffer → @vow/portaudio（koffi→PortAudio，worker 线程）→ VB-Cable → 桌面应用
// 输出：WASAPI loopback → loopback-capture → SSE → 手机

import type { AudioDeviceStatus } from '@vow/shared/types'
import { INPUT_RING_BUFFER_SAMPLES, VB_CABLE_KEYWORD } from '@vow/shared/constants'
import { getPortAudio } from '@vow/portaudio'
import type { PortAudioApi, PortAudioDevice, PortAudioOutputStream } from '@vow/portaudio'

// 输出端点采样率**不可硬编码**：WASAPI 共享模式要求 Pa_OpenStream 的 sampleRate
// 与端点混音格式（PortAudio 上报的 device.defaultSampleRate）完全一致，否则
// 直接失败 "Invalid sample rate"（实测本机 CABLE Input 端点混音格式为 48000Hz，
// 而历史代码写死 44100 → 虚拟麦克风永远开不了流）。
// 运行时由设备 defaultSampleRate 决定；此常量仅作设备未上报采样率时的兜底。
const FALLBACK_SAMPLE_RATE = 44100
const OUTPUT_CHANNELS = 2
/** 设备采样率打开失败时的降级候选（设备上报值不可信时依次尝试） */
const RATE_FALLBACKS = [48000, 44100]

/** 设备未上报 / 上报非法采样率时回退兜底值 */
function normalizeRate(rate: number | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : FALLBACK_SAMPLE_RATE
}

/** 去重并剔除非法值，保持给定优先级（队首优先） */
function dedupeRates(rates: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const r of rates) {
    if (Number.isFinite(r) && r > 0 && !seen.has(r)) {
      seen.add(r)
      out.push(r)
    }
  }
  return out
}

/** PortAudio 的 paInvalidSampleRate 文本为 "Invalid sample rate"——据此判定是否值得换率重试 */
function isSampleRateError(err: unknown): boolean {
  return /sample rate/i.test(err instanceof Error ? err.message : String(err))
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

// ─── 动态加载（loopback-capture 为 N-API 预编译包，无需现场编译）───

import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)

let _LoopbackCaptureCtor: (new () => LoopbackCaptureInstance) | null = null
function lcCtor(): new () => LoopbackCaptureInstance {
  if (!_LoopbackCaptureCtor) {
    const mod = req('loopback-capture') as LoopbackCaptureModule
    _LoopbackCaptureCtor = mod.LoopbackCapture
    console.log('[VirtualAudio] loopback-capture loaded')
  }
  return _LoopbackCaptureCtor
}

// ─── 设备选择（纯函数，供单测直测）───

/** 实测可用的多声道渲染端点命名特征：VB-Cable 的 16ch 端点开流稳定，
 *  而同名的 plain "CABLE Input" 在 WASAPI 上恒报 Invalid device（元数据无法区分——
 *  两者都上报 2 声道 / 48000Hz），只能靠名字偏好 + 开流逐一尝试兜底。 */
const CABLE_MULTICH_SUFFIX = '16ch'

/**
 * 扫描 VB-Cable 渲染端点，返回**按开流成功率启发排序的候选列表**（最佳在前），
 * 调用方须依次尝试直到某一候选开流成功。
 *
 * 排序（仅影响首次开流的尝试顺序，不影响正确性——真正的判据是开流是否成功）：
 *   1. WASAPI 优先（共享模式低延迟；MME/DirectSound 仅作最后兜底）
 *   2. "16ch" 端点优先（已知可用；plain "CABLE Input" 元数据等价但开流失败）
 *   3. 输出声道数越接近 2 越省（写入的是交错立体声）
 *
 * 必须至少 2 个输出声道——写入的是交错立体声，单声道端点会损坏音频。
 */
export function selectCableDevices(devices: PortAudioDevice[]): PortAudioDevice[] {
  return devices
    .filter((d) => d.name.toUpperCase().includes(VB_CABLE_KEYWORD) && d.maxOutputChannels >= 2)
    .sort((a, b) => cableRank(a) - cableRank(b))
}

/** 越小越优先 */
function cableRank(d: PortAudioDevice): number {
  let rank = 0
  if (d.hostAPIName !== 'Windows WASAPI') rank += 1000
  if (!d.name.toLowerCase().includes(CABLE_MULTICH_SUFFIX)) rank += 100
  rank += Math.abs(d.maxOutputChannels - 2)
  return rank
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
  /** 目标端点采样率（由设备 defaultSampleRate 决定；writeInputPCM 据此重采样） */
  private inputSampleRate = FALLBACK_SAMPLE_RATE
  private outputDeviceId: number | null = null
  private inputActive = false
  private outputActive = false
  private inputStream: PortAudioOutputStream | null = null
  private inputTimer: ReturnType<typeof setInterval> | null = null
  /** startInput 重入锁：writeInputPCM 以音频块频率触发，防止并发开流 */
  private inputOpening = false
  private outputCapture: LoopbackCaptureInstance | null = null
  private ringBuffer = new RingBuffer(INPUT_RING_BUFFER_SAMPLES)
  private outputCallback: ((buf: Buffer) => void) | null = null
  /** 上次输入流打开失败的时间戳——失败后 1s 内不重试，防止按 chunk 刷屏 */
  private lastInputFailAt = 0
  /** 候选渲染端点（按可用性启发排序）——start() 时扫描一次，开流时逐一尝试 */
  private cableCandidates: PortAudioDevice[] = []

  /** @param pa 注入 PortAudio 实现（默认进程内单例；测试注入替身） */
  constructor(private readonly pa: PortAudioApi = getPortAudio()) {}

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

  async start(): Promise<void> {
    console.log('[VirtualAudio] scanning devices...')
    let devices: PortAudioDevice[] = []
    try {
      devices = await this.pa.getDevices()
    } catch (err) {
      console.warn('[VirtualAudio] device scan failed:', err instanceof Error ? err.message : err)
    }

    this.cableCandidates = selectCableDevices(devices)
    const dev = this.cableCandidates[0]
    if (dev) {
      this.inputDeviceId = dev.id
      this.inputDeviceName = dev.name
      this.inputSampleRate = normalizeRate(dev.defaultSampleRate)
      console.log(
        `[VirtualAudio] Virtual input candidates: ${this.cableCandidates.map((d) => `#${d.id} "${d.name}"`).join(' | ')}`,
      )
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

  async stop(): Promise<void> {
    this.stopInput()
    this.stopOutput()
    this.ringBuffer.clear()
    await this.pa.shutdown()
    console.log('[VirtualAudio] stopped')
  }

  // ─── 输入链路：手机 PCM → RingBuffer → VB-Cable ───

  writeInputPCM(data: { data: string; sampleRate: number }): void {
    if (!this.inputDeviceId) return
    const float32 = base64ToFloat32(data.data)
    if (float32.length === 0) return
    // 手机实际采样率常为 48000，端点采样率由设备决定（多见 48000，亦可能 44100）——
    // 二者不一致时必须重采样，否则麦克风声音会被拉慢/降调
    const resampled = this.resample(float32, data.sampleRate || this.inputSampleRate, this.inputSampleRate)
    this.ringBuffer.write(resampled)
    // 失败退避：上次打开失败 1s 内不重试（否则每个音频块都会刷一条错误）
    if (
      !this.inputActive &&
      !this.inputOpening &&
      this.ringBuffer.available > 1024 &&
      Date.now() - this.lastInputFailAt > 1000
    ) {
      void this.startInput()
    }
  }

  /** 线性插值重采样 from→to（from==to 或空输入直接返回原数组） */
  private resample(input: Float32Array, from: number, to: number): Float32Array {
    if (from === to || input.length === 0) return input
    const ratio = from / to
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

  private async startInput(): Promise<void> {
    if (this.inputDeviceId === null || this.inputActive || this.inputOpening) return
    this.inputOpening = true
    try {
      const tried = new Set<number>()
      const candidates = this.cableCandidates.length > 0 ? this.cableCandidates : await this.rescanCandidates()
      if (await this.openInputStream(candidates, tried)) return

      // 打开失败：PortAudio 的设备枚举可能已漂移（tsx watch 硬杀进程后
      // WASAPI 端点会重枚举，缓存的 id 失效报 "Invalid device"）——重扫一次，
      // 只试尚未试过的 id（同 id 重试无意义，只会刷屏）
      const fresh = (await this.rescanCandidates()).filter((d) => !tried.has(d.id))
      if (fresh.length > 0) {
        console.warn(`[VirtualAudio] device rescan → 新候选: ${fresh.map((d) => `#${d.id} "${d.name}"`).join(', ')}`)
        if (await this.openInputStream(fresh, tried)) return
      }
      // 仍失败：记录退避时间戳，1s 后才允许再次尝试
      this.lastInputFailAt = Date.now()
    } finally {
      this.inputOpening = false
    }
  }

  /** 重扫 VB-Cable 候选端点（枚举失败返回空列表，不抛） */
  private async rescanCandidates(): Promise<PortAudioDevice[]> {
    try {
      return selectCableDevices(await this.pa.getDevices())
    } catch (err) {
      console.warn('[VirtualAudio] device rescan failed:', err instanceof Error ? err.message : err)
      return []
    }
  }

  /**
   * 依次尝试「设备 × 采样率」组合开流，首个成功者生效并启动推送定时器。
   * - 采样率被拒（paInvalidSampleRate）→ 该设备换下一个候选采样率
   * - 其他错误（paInvalidDevice / 设备占用）→ 换下一个候选设备
   * 这是元数据无法区分可用端点时的真正判据（见 selectCableDevices 注释）。
   */
  private async openInputStream(candidates: PortAudioDevice[], tried: Set<number>): Promise<boolean> {
    let lastErr: unknown = null
    for (const dev of candidates) {
      tried.add(dev.id)
      for (const rate of dedupeRates([normalizeRate(dev.defaultSampleRate), ...RATE_FALLBACKS])) {
        try {
          const stream = await this.pa.openOutput({
            deviceId: dev.id,
            sampleRate: rate,
            channelCount: OUTPUT_CHANNELS,
          })

          this.inputDeviceId = dev.id
          this.inputDeviceName = dev.name
          this.inputSampleRate = rate
          this.inputStream = stream

          // 必须注册 error 回调——流出错时释放并进入退避（原 naudiodon closeOnError 语义）
          stream.onError((err) => {
            console.error('[VirtualAudio] input stream error:', err.message)
            this.stopInput()
            this.lastInputFailAt = Date.now()
          })

          this.inputActive = true
          const intervalMs = this.startInputTimer(rate)
          console.log(`[VirtualAudio] input stream -> "${dev.name}" (id=${dev.id}, ${rate}Hz float32 stereo, ${intervalMs}ms timer)`)
          return true
        } catch (err) {
          lastErr = err
          if (!isSampleRateError(err)) break // 非采样率错误：该设备换率无意义 → 下一候选设备
          console.warn(`[VirtualAudio] "${dev.name}" 拒绝 ${rate}Hz — 尝试降级采样率`)
        }
      }
    }

    console.error(
      '[VirtualAudio] input open failed:',
      `候选端点 [${candidates.map((d) => `#${d.id} "${d.name}"`).join(', ')}] 均无法开流 —`,
      lastErr instanceof Error ? lastErr.message : String(lastErr),
    )
    this.lastInputFailAt = Date.now()
    return false
  }

  /** 启动推送定时器：每 1024/rate 秒从环形缓冲取 1024 个端点采样率样本，
   *  复制为 2048 帧交错立体声写入声卡。返回节拍毫秒数（供日志）。
   *  注意：输出链路是 2ch interleaved，若直接写单声道样本会被当作 L/R 交错导致音频损坏 */
  private startInputTimer(rate: number): number {
    const MONO_CHUNK = 1024
    const intervalMs = Math.round((MONO_CHUNK / rate) * 1000)
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
        this.inputStream.write(stereo)
      } catch { /* stream closed */ }
      // 空闲检测：连续 ~60 tick（约 1.4s）无新数据则关闭设备，
      // 释放 CABLE（否则虚拟麦克风永远显示"使用中"）；新数据到达会自动重启
      idleTicks = read < MONO_CHUNK / 4 ? idleTicks + 1 : 0
      if (idleTicks > 60) {
        console.log('[VirtualAudio] input idle — releasing VB-Cable device')
        this.stopInput()
      }
    }, intervalMs)
    return intervalMs
  }

  private stopInput(): void {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = null }
    if (this.inputStream) {
      void this.inputStream.stop().catch(() => { /* stream closed */ })
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
