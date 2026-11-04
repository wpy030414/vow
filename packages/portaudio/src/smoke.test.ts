// packages/portaudio/src/smoke.test.ts —— PortAudio 链路冒烟 / 回归
//
// 用途：DLL 升级、worker-source.ts 结构体布局改动、FFI 声明面调整之后跑一遍，
//       验证「枚举 → 开流 → 写入 → 释放」整条 koffi→PortAudio 链路。
//
// ⚠ 真实硬件依赖：非 win32 / DLL 缺失 / 无可用输出设备时**自动跳过**（不判失败），
//   因此可在 CI 与无音频设备的机器上安全运行。
//
// 手动听感验证（可选）：PMC_SMOKE_TONE_MS=2000 pnpm --filter @vow/portaudio test

import { describe, it, expect } from 'vitest'
import { createPortAudio } from './index'

const SAMPLE_RATE = 44100
const FRAMES = 1024
const CHANNELS = 2
const TONE_HZ = 440
const TONE_GAIN = 0.2

/** 需要真实音频硬件的用例：platform/DLL 不满足时整体跳过 */
const hasHardware = process.platform === 'win32'
const describeIfHardware = hasHardware ? describe : describe.skip

describe('PortAudio supported 标志', () => {
  it('supported 与平台一致：非 win32 必为 false，且不抛错', () => {
    const pa = createPortAudio()
    if (process.platform !== 'win32') expect(pa.supported).toBe(false)
    expect(typeof pa.supported).toBe('boolean')
  })

  it('非 win32 下 getDevices 安全拒绝而非崩溃', async () => {
    if (process.platform === 'win32') return
    const pa = createPortAudio()
    await expect(pa.getDevices()).rejects.toThrow()
  })

  it('shutdown 幂等：未开流时 Repeated 调用均 resolve', async () => {
    const pa = createPortAudio()
    await expect(pa.shutdown()).resolves.toBeUndefined()
    await expect(pa.shutdown()).resolves.toBeUndefined()
  })
})

describeIfHardware('真实链路：枚举 / 开流 / 写入 / 释放', () => {
  it('枚举设备：id 唯一；真实端点的字段完整', async () => {
    const pa = createPortAudio()
    try {
      const devices = await pa.getDevices()
      expect(Array.isArray(devices)).toBe(true)

      // id 唯一性对全部枚举结果成立（含幽灵设备）
      const ids = devices.map((d) => d.id)
      expect(new Set(ids).size).toBe(ids.length)

      // WASAPI 枚举偶发返回「无名称 / 0 声道 / 0 采样率」的空壳端点——
      // 这是 PortAudio 侧的既有行为，不是本项目缺陷；selectCableDevices 亦会将其剔除。
      // 因此只对真实端点（有名称且至少一个声道）校验字段完整性。
      const real = devices.filter(
        (d) => d.name.length > 0 && d.maxOutputChannels + d.maxInputChannels > 0,
      )
      for (const d of real) {
        expect(d.name.length).toBeGreaterThan(0)
        expect(typeof d.hostAPIName).toBe('string')
        expect(Number.isInteger(d.maxOutputChannels)).toBe(true)
        expect(Number.isFinite(d.defaultSampleRate)).toBe(true)
        expect(d.defaultSampleRate).toBeGreaterThan(0)
      }
    } finally {
      await pa.shutdown()
    }
  })

  it('开流 → 写入正弦 → 停止：全链路无错误', async () => {
    const pa = createPortAudio()
    try {
      if (!pa.supported) return // DLL 缺失：跳过，不判失败

      const devices = await pa.getDevices()
      const target = devices.find((d) => d.maxOutputChannels >= CHANNELS)
      if (!target) return // 无多声道输出设备：跳过

      const rate = Number.isFinite(target.defaultSampleRate)
        ? target.defaultSampleRate
        : SAMPLE_RATE

      const stream = await pa.openOutput({
        deviceId: target.id,
        sampleRate: rate,
        channelCount: CHANNELS,
      })

      const errors: string[] = []
      stream.onError((e) => errors.push(e.message))

      // 写入约 200ms 的正弦（若设置 PMC_SMOKE_TONE_MS 则按其时长，便于手动听感）
      const overrideMs = Number(process.env.PMC_SMOKE_TONE_MS ?? 0)
      const blocks = Math.ceil((((overrideMs || 200) / 1000) * rate) / FRAMES)
      let phase = 0

      for (let b = 0; b < blocks; b++) {
        const buf = new Float32Array(FRAMES * CHANNELS)
        for (let i = 0; i < FRAMES; i++) {
          const v = Math.sin(phase) * TONE_GAIN
          phase += (2 * Math.PI * TONE_HZ) / rate
          buf[i * 2] = v
          buf[i * 2 + 1] = v
        }
        stream.write(buf)
        await new Promise((r) => setTimeout(r, Math.round((FRAMES / rate) * 1000)))
      }

      await stream.stop()
      expect(errors).toEqual([])
    } finally {
      await pa.shutdown()
    }
  })
})
