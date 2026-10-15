// @vow/portaudio —— 公开 API 与 worker 协议类型
//
// ⚠ 协议字段与 src/worker-source.ts 中的字符串实现必须同步维护
//   （apps/server 的 portaudio.test.ts 协议测试负责守护）

export interface PortAudioDevice {
  id: number
  name: string
  hostAPIName: string
  maxInputChannels: number
  maxOutputChannels: number
  defaultSampleRate: number
  defaultLowOutputLatency: number
}

export interface PortAudioOutputStream {
  /**
   * 写入一块交错立体声 Float32 数据（如 2ch × 1024 帧 = 2048 个样本）。
   * 注意：底层会将 ArrayBuffer 转移（transfer）给 worker——调用后该数组被 detach，
   * 不得复用；每次写入请新分配（现有调用方即为每 tick 新分配）。
   */
  write(interleaved: Float32Array): void
  /** 停止并关闭流（Pa_StopStream 等待已入缓冲播完 + Pa_CloseStream）；幂等 */
  stop(): Promise<void>
  /** 注册错误回调（单回调，覆盖注册）；注册前若已有错误会立即补发 */
  onError(cb: (err: Error) => void): void
}

export interface PortAudioApi {
  /** 平台/路径解析是否可用（非 win32 或资源缺失 → false，接口仍可安全调用） */
  readonly supported: boolean
  getDevices(): Promise<PortAudioDevice[]>
  openOutput(opts: { deviceId: number; sampleRate: number; channelCount: number }): Promise<PortAudioOutputStream>
  /** 关闭全部流、终止 worker；幂等；调用后本实例不可再使用 */
  shutdown(): Promise<void>
}

// ─── worker 协议（与 worker-source.ts 同步）───

export interface PortAudioWorkerData {
  dllPath: string
  koffiPath: string
}

export type MainToWorker =
  | { kind: 'req'; id: number; op: 'getDevices' }
  | { kind: 'req'; id: number; op: 'openOutput'; deviceId: number; sampleRate: number; channelCount: number }
  | { kind: 'req'; id: number; op: 'closeOutput'; token: number }
  | { kind: 'req'; id: number; op: 'shutdown' }
  | { kind: 'write'; token: number; audio: Float32Array }

export type WorkerToMain =
  | { kind: 'reply'; id: number; ok: true; result: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
  | { kind: 'streamError'; token: number; code: number; message: string }

/** 测试替身接口（真身为 node:worker_threads 的 Worker） */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: readonly ArrayBuffer[]): void
  on(event: 'message' | 'error' | 'exit', cb: (...args: unknown[]) => void): unknown
  terminate(): Promise<number> | number
  unref?(): void
}
