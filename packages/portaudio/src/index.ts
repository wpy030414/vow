// @vow/portaudio —— 主线程侧 API：路径解析、worker 桥、流对象
//
// 设计要点（详见 docs/DECISIONS.md A12）：
// - 全部 Pa_* 调用发生在独立 worker 线程：阻塞式 Pa_WriteStream 不阻塞主事件循环；
//   PaStream 有线程亲和性，不能分散到 koffi.async 的线程池
// - dev(tsx) 与 prod(tsup 内联 server bundle) 共用同一套运行时路径解析（两级 createRequire）
// - 非 win32 / 资源缺失 → supported=false 降级（零 throw）；worker 崩溃 → 上报并自动重启

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { PORTAUDIO_WORKER_SOURCE } from './worker-source'
import type {
  MainToWorker,
  PortAudioApi,
  PortAudioDevice,
  PortAudioOutputStream,
  WorkerLike,
  WorkerToMain,
} from './types'

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000

export interface CreatePortAudioOptions {
  /** 测试注入：平台（默认 process.platform） */
  platform?: NodeJS.Platform
  /** 测试注入：替身 worker 工厂 */
  spawnWorker?: (source: string, workerData: unknown) => WorkerLike
  /** 测试注入：DLL / koffi 路径解析 */
  resolvePaths?: () => { dllPath: string; koffiPath: string } | null
  requestTimeoutMs?: number
  shutdownGraceMs?: number
}

interface StreamState {
  onError: ((err: Error) => void) | null
  /** 错误早于 onError 注册时暂存（注册瞬间补发） */
  pendingError: Error | null
  dead: boolean
}

export function createPortAudio(opts: CreatePortAudioOptions = {}): PortAudioApi {
  const platform = opts.platform ?? process.platform
  const resolvePaths = opts.resolvePaths ?? defaultResolvePaths
  const spawn = opts.spawnWorker ?? defaultSpawnWorker
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS

  const paths = platform === 'win32' ? safeResolve(resolvePaths) : null
  const supported = !!paths && existsSync(paths.dllPath)

  let worker: WorkerLike | null = null
  let closed = false
  let nextReqId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const liveStreams = new Map<number, StreamState>()

  function ensureWorker(): WorkerLike {
    if (worker) return worker
    // supported 为真时 paths 必然非空
    const w = spawn(PORTAUDIO_WORKER_SOURCE, { dllPath: paths!.dllPath, koffiPath: paths!.koffiPath })
    worker = w
    w.unref?.()
    w.on('message', (raw) => onWorkerMessage(raw as WorkerToMain))
    w.on('error', (err) => markDead(`worker 异常: ${err instanceof Error ? err.message : String(err)}`))
    w.on('exit', (code) => {
      // 正常 shutdown 会先置 worker=null，此处仅处理意外退出
      if (worker === w) markDead(`worker 退出 (code=${String(code)})`)
    })
    forwardOutput(w)
    return w
  }

  function onWorkerMessage(msg: WorkerToMain): void {
    if (msg.kind === 'reply') {
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.result)
      else entry.reject(new Error(msg.error))
      return
    }
    if (msg.kind === 'streamError') {
      const st = liveStreams.get(msg.token)
      if (!st) return
      st.dead = true
      liveStreams.delete(msg.token)
      const err = new Error(`PortAudio 流错误(${msg.code}): ${msg.message}`)
      if (st.onError) st.onError(err)
      else st.pendingError = err
    }
  }

  /** worker 意外死亡：拒绝全部在途请求，向活跃流上报错误（调用方既有退避逻辑接管恢复） */
  function markDead(cause: string): void {
    console.warn(`[PortAudio] ${cause}`)
    worker = null
    for (const [, entry] of pending) entry.reject(new Error(cause))
    pending.clear()
    for (const st of liveStreams.values()) {
      st.dead = true
      const err = new Error(cause)
      if (st.onError) st.onError(err)
      else st.pendingError = err
    }
    liveStreams.clear()
  }

  function request<T>(
    payload:
      | { op: 'getDevices' }
      | { op: 'openOutput'; deviceId: number; sampleRate: number; channelCount: number }
      | { op: 'closeOutput'; token: number },
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (closed || !supported) {
        reject(new Error('PortAudio 不可用'))
        return
      }
      const id = nextReqId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`PortAudio 请求超时: ${payload.op}`))
      }, requestTimeoutMs)
      timer.unref?.()
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        ensureWorker().postMessage({ kind: 'req', id, ...payload } as MainToWorker)
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async function getDevices(): Promise<PortAudioDevice[]> {
    if (!supported) return []
    const devices = await request<PortAudioDevice[]>({ op: 'getDevices' })
    return Array.isArray(devices) ? devices : []
  }

  async function openOutput(o: { deviceId: number; sampleRate: number; channelCount: number }): Promise<PortAudioOutputStream> {
    if (!supported) throw new Error('PortAudio 不可用（非 win32 或 DLL/依赖缺失）')
    const { token } = await request<{ token: number }>({ op: 'openOutput', ...o })
    const st: StreamState = { onError: null, pendingError: null, dead: false }
    liveStreams.set(token, st)

    return {
      write(interleaved: Float32Array): void {
        if (st.dead) return
        const w = worker
        if (!w) return
        try {
          w.postMessage({ kind: 'write', token, audio: interleaved } as MainToWorker, [interleaved.buffer as ArrayBuffer])
        } catch {
          /* worker 死亡竞态：按丢弃处理（错误经 onError / markDead 上报） */
        }
      },
      async stop(): Promise<void> {
        if (st.dead) return
        st.dead = true
        liveStreams.delete(token)
        try {
          await request<unknown>({ op: 'closeOutput', token })
        } catch {
          /* worker 已死则无需关闭 */
        }
      },
      onError(cb: (err: Error) => void): void {
        st.onError = cb
        if (st.pendingError) {
          const err = st.pendingError
          st.pendingError = null
          cb(err)
        }
      },
    }
  }

  async function shutdown(): Promise<void> {
    if (closed) return
    closed = true
    const w = worker
    worker = null
    for (const st of liveStreams.values()) st.dead = true
    liveStreams.clear()
    for (const [, entry] of pending) entry.reject(new Error('PortAudio 已关闭'))
    pending.clear()
    if (!w) return

    // 宽限窗口内等待 worker 自行清理（关流 + Pa_Terminate），随后无条件 terminate
    await new Promise<void>((resolve) => {
      const id = nextReqId++
      const timer = setTimeout(resolve, shutdownGraceMs)
      timer.unref?.()
      pending.set(id, {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: () => { clearTimeout(timer); resolve() },
      })
      try {
        w.postMessage({ kind: 'req', id, op: 'shutdown' } as MainToWorker)
      } catch {
        pending.delete(id)
        clearTimeout(timer)
        resolve()
      }
    })
    try {
      await w.terminate()
    } catch {
      /* noop */
    }
  }

  return { supported, getDevices, openOutput, shutdown }
}

let singleton: PortAudioApi | null = null

/** 进程内单例（惰性创建；测试请直接用 createPortAudio 注入替身） */
export function getPortAudio(): PortAudioApi {
  return (singleton ??= createPortAudio())
}

function defaultSpawnWorker(source: string, workerData: unknown): WorkerLike {
  const w = new Worker(source, { eval: true, workerData, name: 'vow-portaudio', stdout: true, stderr: true })
  return w as unknown as WorkerLike
}

/** 把 worker 的 stdout/stderr（PortAudio 横幅/告警）按行转发到主进程日志 */
function forwardOutput(w: WorkerLike): void {
  const anyW = w as unknown as { stdout?: NodeJS.ReadableStream | null; stderr?: NodeJS.ReadableStream | null }
  for (const stream of [anyW.stdout, anyW.stderr]) {
    if (!stream) continue
    let buffered = ''
    stream.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) console.log(`[PortAudio] ${line.trim()}`)
    })
  }
}

function safeResolve(resolvePaths: () => { dllPath: string; koffiPath: string } | null): { dllPath: string; koffiPath: string } | null {
  try {
    return resolvePaths()
  } catch {
    return null
  }
}

/**
 * 运行时定位包内资源（dev=包内 src；prod=tsup 内联进 server bundle 后亦可）：
 * - package.json 的 exports 必须导出 "./package.json"（本函数依赖此约定，勿删）
 * - koffi 是本包自身依赖，必须经包级 require 解析（pnpm 严格布局下 server 依赖树不可见）
 */
function defaultResolvePaths(): { dllPath: string; koffiPath: string } | null {
  try {
    const req = createRequire(import.meta.url)
    const pkgJson = req.resolve('@vow/portaudio/package.json')
    const dllPath = join(dirname(pkgJson), 'bin', 'portaudio_x64.dll')
    const koffiPath = createRequire(pkgJson).resolve('koffi')
    return { dllPath, koffiPath }
  } catch {
    return null
  }
}

export type { MainToWorker, PortAudioApi, PortAudioDevice, PortAudioOutputStream, WorkerLike, WorkerToMain } from './types'
