// virtual-audio 服务测试：替身 PortAudioApi + fake timers（零 vi.mock，沿用仓库惯例）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VirtualAudioManager, selectCableDevice } from './virtual-audio'
import type { PortAudioApi, PortAudioDevice, PortAudioOutputStream } from '@vow/portaudio'

const SR = 44100

/** 生成指定样本数的常量值 PCM16 base64 块 */
function chunk(samples: number, value = 0.5, sampleRate = SR): { data: string; sampleRate: number } {
  const int16 = new Int16Array(samples)
  for (let i = 0; i < samples; i++) int16[i] = Math.round(value * 32767)
  return { data: Buffer.from(int16.buffer).toString('base64'), sampleRate }
}

function device(id: number, over: Partial<PortAudioDevice> = {}): PortAudioDevice {
  return {
    id,
    name: 'CABLE In 16ch (VB-Audio Virtual Cable)',
    hostAPIName: 'Windows WASAPI',
    maxInputChannels: 0,
    maxOutputChannels: 2,
    defaultSampleRate: 44100,
    defaultLowOutputLatency: 0.01,
    ...over,
  }
}

interface FakeStream {
  writes: Float32Array[]
  stopCount: number
  errorCb: ((err: Error) => void) | null
  stream: PortAudioOutputStream
}

function createFake() {
  const opens: Array<{ deviceId: number; sampleRate: number; channelCount: number }> = []
  const streams: FakeStream[] = []
  const openErrors: Error[] = []
  const deviceQueue: PortAudioDevice[][] = []
  let shutdownCount = 0

  const api: PortAudioApi = {
    supported: true,
    getDevices: async () => {
      if (deviceQueue.length > 1) return deviceQueue.shift()!
      return deviceQueue[0] ?? []
    },
    openOutput: async (o) => {
      opens.push({ ...o })
      const err = openErrors.shift()
      if (err) throw err
      const fs: Partial<FakeStream> = { writes: [], stopCount: 0, errorCb: null }
      fs.stream = {
        write: (f) => { fs.writes!.push(f) },
        stop: async () => { fs.stopCount! += 1 },
        onError: (cb) => { fs.errorCb = cb },
      }
      streams.push(fs as FakeStream)
      return fs.stream
    },
    shutdown: async () => { shutdownCount += 1 },
  }

  return {
    api,
    opens,
    streams,
    openErrors,
    setDevices: (...sets: PortAudioDevice[][]) => { deviceQueue.length = 0; deviceQueue.push(...sets) },
    get shutdownCount() { return shutdownCount },
  }
}

type Fake = ReturnType<typeof createFake>

/** 冲净 openOutput 的异步链（advanceTimersByTimeAsync 会 await 内部微任务） */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

/** 推进 n 个 23ms 节拍 */
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await vi.advanceTimersByTimeAsync(23)
}

/** 常用：启动（扫描 D21）→ 喂 1200 样本 → 等开流完成 */
async function openStream(f: Fake, samples = 1200): Promise<VirtualAudioManager> {
  const mgr = new VirtualAudioManager(f.api)
  await mgr.start()
  mgr.writeInputPCM(chunk(samples))
  await settle()
  expect(f.opens.length).toBe(1)
  return mgr
}

describe('selectCableDevice', () => {
  it('优先恰好 2 声道的 WASAPI CABLE 端点', () => {
    const picked = selectCableDevice([
      device(1, { maxOutputChannels: 16 }),
      device(2, { maxOutputChannels: 2 }),
      device(3, { maxOutputChannels: 8 }),
    ])
    expect(picked?.id).toBe(2)
  })

  it('排除非 WASAPI / 单声道 / 非 CABLE；空列表返回 null', () => {
    expect(selectCableDevice([device(1, { hostAPIName: 'MME' })])).toBeNull()
    expect(selectCableDevice([device(1, { maxOutputChannels: 1 })])).toBeNull()
    expect(selectCableDevice([device(1, { name: 'Speakers' })])).toBeNull()
    expect(selectCableDevice([])).toBeNull()
  })
})

describe('VirtualAudioManager（替身 PortAudio）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('start：扫描到 CABLE → installed；无设备 → not_installed 且安装提示不变', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = new VirtualAudioManager(f.api)
    await mgr.start()
    const st = mgr.getDeviceStatus()
    expect(st.virtualInputAvailable).toBe(true)
    expect(st.inputDeviceName).toBe('CABLE In 16ch (VB-Audio Virtual Cable)')
    expect(st.installStatus).toBe('installed')

    const f2 = createFake()
    const mgr2 = new VirtualAudioManager(f2.api)
    await mgr2.start()
    expect(mgr2.getDeviceStatus().installStatus).toBe('not_installed')
    expect(mgr2.getDeviceStatus().installError).toContain('get-driver')
  })

  it('阈值：≤1024 样本不开流，越过阈值后开流且参数正确', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = new VirtualAudioManager(f.api)
    await mgr.start()

    mgr.writeInputPCM(chunk(600))
    await settle()
    expect(f.opens.length).toBe(0) // 未达阈值

    mgr.writeInputPCM(chunk(600)) // 累计 1200 > 1024
    await settle()
    expect(f.opens.length).toBe(1)
    expect(f.opens[0]).toEqual({ deviceId: 21, sampleRate: 44100, channelCount: 2 })
    expect(mgr.getDeviceStatus().inputActive).toBe(true)
    await mgr.stop()
  })

  it('23ms 节拍：交错立体声写入 + 未读满静音填充', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = await openStream(f) // 1200 样本

    await tick() // 第 1 拍：读满 1024
    const w0 = f.streams[0].writes[0]
    expect(w0.length).toBe(2048)
    expect(w0[0]).toBeCloseTo(0.5)
    expect(w0[1]).toBeCloseTo(0.5)
    expect(w0[2046]).toBeCloseTo(0.5)

    await tick() // 第 2 拍：只剩 176 → 其余静音
    const w1 = f.streams[0].writes[1]
    expect(w1.length).toBe(2048)
    expect(w1[175 * 2]).toBeCloseTo(0.5)
    expect(w1[176 * 2]).toBe(0)
    await mgr.stop()
  })

  it('48k 重采样：入 1176 → 出 1080（比例正确，常量值保持）', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = new VirtualAudioManager(f.api)
    await mgr.start()
    mgr.writeInputPCM(chunk(1176, 0.5, 48000))
    await settle()
    expect(f.opens.length).toBe(1)

    await tick()
    const w0 = f.streams[0].writes[0]
    expect(w0[0]).toBeCloseTo(0.5)
    await tick()
    const w1 = f.streams[0].writes[1]
    // 重采样后总输出 = floor(1176 / 1.0884) = 1080 帧：第二拍只应剩 56 帧
    // （若未重采样会是 152 帧，此断言即为判别器）
    expect(w1[55 * 2]).toBeCloseTo(0.5)
    expect(w1[56 * 2]).toBe(0)
    await mgr.stop()
  })

  it('空闲 60+ tick 释放设备，再喂数据自动重启', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = await openStream(f)

    await tick(63) // 首拍读满后 61 个低读拍 → 释放
    expect(f.streams[0].stopCount).toBe(1)
    expect(mgr.getDeviceStatus().inputActive).toBe(false)

    mgr.writeInputPCM(chunk(1200)) // 新数据 → 自动重启
    await settle()
    expect(f.opens.length).toBe(2)
    expect(mgr.getDeviceStatus().inputActive).toBe(true)
    await mgr.stop()
  })

  it('漂移重试：开流失败 → 重扫得到新 id 并成功', async () => {
    const f = createFake()
    f.setDevices([device(21)], [device(33)])
    f.openErrors.push(new Error('Invalid device'))
    const mgr = new VirtualAudioManager(f.api)
    await mgr.start()
    mgr.writeInputPCM(chunk(1200))
    await settle()

    expect(f.opens.length).toBe(2)
    expect(f.opens[1].deviceId).toBe(33) // 换用了重扫到的新 id
    expect(mgr.getDeviceStatus().inputActive).toBe(true)
    await mgr.stop()
  })

  it('连续失败：1s 退避限频，过后可重试', async () => {
    const f = createFake()
    f.setDevices([device(21)]) // 重扫仍是同一 id → 不触发漂移重试
    f.openErrors.push(new Error('e1'))
    const mgr = new VirtualAudioManager(f.api)
    await mgr.start()
    mgr.writeInputPCM(chunk(1200))
    await settle()
    expect(f.opens.length).toBe(1) // 打开失败，且同 id 不重试

    mgr.writeInputPCM(chunk(1200)) // 1s 内 → 退避，不重试
    await settle()
    expect(f.opens.length).toBe(1)

    await vi.advanceTimersByTimeAsync(1100) // 退避判据是 >1000，需严格越过
    mgr.writeInputPCM(chunk(1200))
    await settle()
    expect(f.opens.length).toBe(2)
    await mgr.stop()
  })

  it('流错误：停止并进入 1s 退避，过后自动恢复', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = await openStream(f)

    f.streams[0].errorCb?.(new Error('stream died'))
    expect(mgr.getDeviceStatus().inputActive).toBe(false)
    expect(f.streams[0].stopCount).toBe(1)

    mgr.writeInputPCM(chunk(1200)) // 退避中
    await settle()
    expect(f.opens.length).toBe(1)

    await vi.advanceTimersByTimeAsync(1100) // 退避判据是 >1000，需严格越过
    mgr.writeInputPCM(chunk(1200))
    await settle()
    expect(f.opens.length).toBe(2)
    await mgr.stop()
  })

  it('stop()：清定时器、关流、shutdown 被调用', async () => {
    const f = createFake()
    f.setDevices([device(21)])
    const mgr = await openStream(f)
    await tick(2)

    await mgr.stop()
    expect(f.streams[0].stopCount).toBe(1)
    expect(f.shutdownCount).toBe(1)

    const writes = f.streams[0].writes.length
    await tick(5)
    expect(f.streams[0].writes.length).toBe(writes) // 定时器已清
  })
})
