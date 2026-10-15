// @vow/portaudio 协议层测试：替身 worker 桥 + 依赖注入（零 vi.mock，沿用仓库惯例）
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createPortAudio, type CreatePortAudioOptions } from '@vow/portaudio'
import type { MainToWorker, WorkerLike } from '@vow/portaudio'

// 借用测试文件自身作为“存在的文件”，通过 supported 的 existsSync 检查
const SELF = fileURLToPath(import.meta.url)
const PATHS = { dllPath: SELF, koffiPath: SELF }

type Posted = { msg: MainToWorker; transfer?: readonly ArrayBuffer[] }
type Handler = (...args: unknown[]) => void

function fakeWorker() {
  const posted: Posted[] = []
  const handlers: Record<string, Handler[]> = {}
  let terminated = 0
  let unrefed = 0
  const w: WorkerLike = {
    postMessage: (msg, transfer) => { posted.push({ msg: msg as MainToWorker, transfer }) },
    on: (event, cb) => { (handlers[event] ??= []).push(cb); return w },
    terminate: async () => { terminated += 1; return 0 },
    unref: () => { unrefed += 1 },
  }
  const emit = (event: string, payload: unknown) => { for (const cb of handlers[event] ?? []) cb(payload) }
  return {
    w,
    posted,
    reply: (id: number, result: unknown) => emit('message', { kind: 'reply', id, ok: true, result }),
    fail: (id: number, error: string) => emit('message', { kind: 'reply', id, ok: false, error }),
    pushStreamError: (token: number, code: number, message: string) => emit('message', { kind: 'streamError', token, code, message }),
    crash: (err: Error) => emit('error', err),
    get terminated() { return terminated },
    get unrefed() { return unrefed },
  }
}

type Fake = ReturnType<typeof fakeWorker>

function setup(overrides: Partial<CreatePortAudioOptions> = {}) {
  const workers: Fake[] = []
  const spawnWorker = () => { const f = fakeWorker(); workers.push(f); return f.w }
  const pa = createPortAudio({
    platform: 'win32',
    resolvePaths: () => PATHS,
    spawnWorker,
    requestTimeoutMs: 300,
    shutdownGraceMs: 50,
    ...overrides,
  })
  return { pa, workers }
}

const lastReq = (f: Fake): { id: number } & Record<string, unknown> =>
  f.posted.filter((p) => p.msg.kind === 'req').at(-1)!.msg as { id: number } & Record<string, unknown>

const DEVICES = [
  { id: 21, name: 'CABLE In 16ch', hostAPIName: 'Windows WASAPI', maxInputChannels: 0, maxOutputChannels: 2, defaultSampleRate: 44100, defaultLowOutputLatency: 0.01 },
]

describe('portaudio 桥（替身 worker）', () => {
  it('getDevices：惰性拉起 worker（unref）并完成请求应答', async () => {
    const { pa, workers } = setup()
    expect(workers.length).toBe(0) // 使用前不创建 worker
    const p = pa.getDevices()
    expect(workers.length).toBe(1)
    expect(workers[0].unrefed).toBe(1)

    const req = lastReq(workers[0])
    expect(req).toMatchObject({ kind: 'req', op: 'getDevices' })
    workers[0].reply(req.id, DEVICES)
    await expect(p).resolves.toEqual(DEVICES)
  })

  it('openOutput：请求字段正确，应答 token 后返回流对象', async () => {
    const { pa, workers } = setup()
    const p = pa.openOutput({ deviceId: 21, sampleRate: 44100, channelCount: 2 })
    const req = lastReq(workers[0])
    expect(req).toMatchObject({ op: 'openOutput', deviceId: 21, sampleRate: 44100, channelCount: 2 })
    workers[0].reply(req.id, { token: 7 })
    const stream = await p
    expect(typeof stream.write).toBe('function')
    expect(typeof stream.stop).toBe('function')
    expect(typeof stream.onError).toBe('function')
  })

  it('write：携带 transfer 列表；stop 后静默丢弃且 stop 幂等', async () => {
    const { pa, workers } = setup()
    const p = pa.openOutput({ deviceId: 21, sampleRate: 44100, channelCount: 2 })
    workers[0].reply(lastReq(workers[0]).id, { token: 7 })
    const stream = await p

    const chunk = new Float32Array(2048)
    stream.write(chunk)
    const wmsg = workers[0].posted.at(-1)!
    expect(wmsg.msg).toMatchObject({ kind: 'write', token: 7 })
    expect(wmsg.transfer).toEqual([chunk.buffer])

    const stopP = stream.stop()
    const closeReq = lastReq(workers[0])
    expect(closeReq).toMatchObject({ op: 'closeOutput', token: 7 })
    workers[0].reply(closeReq.id, {})
    await stopP

    await stream.stop() // 幂等：不再发请求
    expect(lastReq(workers[0])).toMatchObject({ op: 'closeOutput' })

    const countAfter = workers[0].posted.length
    stream.write(new Float32Array(2048))
    expect(workers[0].posted.length).toBe(countAfter) // 已 dead → 丢弃
  })

  it('streamError：onError 回调；注册前的错误补发；此后 write 丢弃', async () => {
    const { pa, workers } = setup()
    const p = pa.openOutput({ deviceId: 21, sampleRate: 44100, channelCount: 2 })
    workers[0].reply(lastReq(workers[0]).id, { token: 7 })
    const stream = await p

    // 错误早于 onError 注册 → 暂存并在注册时补发
    workers[0].pushStreamError(7, -10020, 'Output underflowed')
    const seen: Error[] = []
    stream.onError((e) => seen.push(e))
    expect(seen.length).toBe(1)
    expect(seen[0].message).toContain('underflowed')

    const n = workers[0].posted.length
    stream.write(new Float32Array(2048))
    expect(workers[0].posted.length).toBe(n) // dead → 丢弃
  })

  it('worker 崩溃：在途请求拒绝、活跃流报错、后续请求自动重启', async () => {
    const { pa, workers } = setup()
    const openP = pa.openOutput({ deviceId: 21, sampleRate: 44100, channelCount: 2 })
    workers[0].reply(lastReq(workers[0]).id, { token: 7 })
    const stream = await openP
    const seen: Error[] = []
    stream.onError((e) => seen.push(e))

    const inFlight = pa.getDevices()
    workers[0].crash(new Error('boom'))
    await expect(inFlight).rejects.toThrow(/boom/)
    expect(seen.length).toBe(1)
    expect(seen[0].message).toContain('boom')
    await expect(stream.stop()).resolves.toBeUndefined() // 已死 → 直接返回

    const q = pa.getDevices()
    expect(workers.length).toBe(2) // 自动重启
    workers[1].reply(lastReq(workers[1]).id, [])
    await expect(q).resolves.toEqual([])
  })

  it('请求失败应答：reject 且带错误文案', async () => {
    const { pa, workers } = setup()
    const p = pa.getDevices()
    workers[0].fail(lastReq(workers[0]).id, 'Pa_Initialize failed: x')
    await expect(p).rejects.toThrow(/Pa_Initialize failed/)
  })

  it('shutdown：通知 worker、宽限超时后 terminate、幂等、之后请求被拒', async () => {
    const { pa, workers } = setup()
    const p = pa.getDevices()
    workers[0].reply(lastReq(workers[0]).id, [])
    await p

    const sp = pa.shutdown()
    expect(lastReq(workers[0])).toMatchObject({ op: 'shutdown' })
    // 不回复 → 宽限（50ms）后 terminate
    await sp
    expect(workers[0].terminated).toBe(1)

    await pa.shutdown() // 幂等
    expect(workers[0].terminated).toBe(1)

    await expect(pa.getDevices()).rejects.toThrow(/不可用/)
  })

  it('非 win32 / 解析失败：supported=false 零 throw 降级', async () => {
    const { pa, workers } = setup({ platform: 'linux' })
    expect(pa.supported).toBe(false)
    await expect(pa.getDevices()).resolves.toEqual([])
    await expect(pa.openOutput({ deviceId: 1, sampleRate: 44100, channelCount: 2 })).rejects.toThrow()
    await expect(pa.shutdown()).resolves.toBeUndefined()
    expect(workers.length).toBe(0)

    const { pa: pa2 } = setup({ resolvePaths: () => null })
    expect(pa2.supported).toBe(false)

    const { pa: pa3 } = setup({ resolvePaths: () => { throw new Error('resolve blew up') } })
    expect(pa3.supported).toBe(false) // safeResolve 兜底
  })
})
