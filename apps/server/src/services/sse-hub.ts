// SSE 连接池管理

import { randomUUID } from 'node:crypto'
import type { ServerEvent, DeviceState, RecordMode, StateUpdateRequest } from '@vow/shared/types'
import { SSE_HEARTBEAT_MS, SSE_SESSION_TTL_MS } from '@vow/shared/constants'

/** 单个客户端会话 */
export interface SSESession {
  id: string
  createdAt: number
  lastHeartbeat: number
  state: DeviceState
  /** SSE writable stream — 用于推送事件给该客户端 */
  writer: WritableStreamDefaultWriter<Uint8Array> | null
  /** 音频数据回调 — 当服务端收到音频 chunk 时触发 */
  onAudioChunk: ((chunk: { data: string; sampleRate: number; timestamp: number; sequence: number }) => void) | null
  /** 输出音频回调 — 当系统音频需发往该客户端时调用 */
  onOutputAudio: ((data: ArrayBuffer) => void) | null
}

/** 事件总线的回调 */
export type HubEventListener = (sessionId: string, event: ServerEvent) => void

export class SSEHub {
  private sessions = new Map<string, SSESession>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<HubEventListener>()

  /** 听写联动回调——某会话的听写态翻转时触发；会话销毁时若听写仍开着则强制释放 */
  onDictationChange: ((active: boolean, sessionId: string, reason: 'toggle' | 'release') => void) | null = null

  /** 会话初始化钩子——每次会话就绪（新建或复活）时调用，用于挂载 onAudioChunk 等外部接线。
   *  比在此猴补丁 createSession 更稳：复活路径同样接线（否则复活的会话收不到上行音频）。 */
  onSessionInit: ((session: SSESession) => void) | null = null

  // ─── 生命周期 ───

  start() {
    this.heartbeatTimer = setInterval(() => this.sendHeartbeats(), SSE_HEARTBEAT_MS)
    this.reapTimer = setInterval(() => this.reapStaleSessions(), 15_000)
    console.log('[SSE Hub] started')
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.reapTimer) clearInterval(this.reapTimer)
    for (const [id, session] of this.sessions) {
      void this.closeWriter(session.writer, id)
    }
    this.sessions.clear()
    console.log('[SSE Hub] stopped')
  }

  // ─── 会话管理 ───

  createSession(_deviceName?: string, mode: RecordMode = 'tap'): SSESession {
    // 随机不可猜：会话 ID 在重连复活路径中兼作凭据（app 层另有配对鉴权，此处防跨会话互串）
    const session = this.makeSession(`vow-${randomUUID()}`, mode)
    this.registerSession(session)
    console.log(`[SSE Hub] session created: ${session.id} (${this.sessions.size} active)`)
    return session
  }

  /** 构造会话对象（不含注册/接线/日志）——新建与复活共用同一形状 */
  private makeSession(id: string, mode: RecordMode): SSESession {
    const now = Date.now()
    return {
      id,
      createdAt: now,
      lastHeartbeat: now,
      state: {
        sessionId: id,
        connected: true,
        mode,
        recording: false,
        isOutputEnabled: false,
        dictation: false,
        audioLevel: 0,
      },
      writer: null,
      onAudioChunk: null,
      onOutputAudio: null,
    }
  }

  /** 注册进会话表并触发初始化接线（onAudioChunk 等） */
  private registerSession(session: SSESession): void {
    this.sessions.set(session.id, session)
    this.onSessionInit?.(session)
  }


  destroySession(id: string) {
    const session = this.sessions.get(id)
    if (!session) return
    // 会话销毁时若听写仍开着，强制释放（页面关闭/断线/TTL 回收路径）
    if (session.state.dictation) {
      session.state.dictation = false
      this.onDictationChange?.(false, id, 'release')
    }
    void this.closeWriter(session.writer, id)
    this.sessions.delete(id)
    console.log(`[SSE Hub] session destroyed: ${id} (${this.sessions.size} active)`)
    this.notifyListeners(id, { type: 'error', payload: 'disconnected', timestamp: Date.now() })
  }

  getSession(id: string): SSESession | undefined {
    return this.sessions.get(id)
  }

  /** 显式刷新会话活跃时间（客户端保活 ping） */
  touch(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.lastHeartbeat = Date.now()
    return true
  }

  getConnectionInfo() {
    return {
      connectedCount: this.sessions.size,
      sessions: Array.from(this.sessions.keys()),
    }
  }

  // ─── SSE Stream ───

  getOrCreateStream(sessionId: string): { session: SSESession; stream: ReadableStream } {
    let session = this.sessions.get(sessionId)
    if (!session) {
      // 复活：EventSource 断线自动重连会携带原 sessionId，而服务端可能已重启（内存会话表
      // 清空）或该会话已被 TTL 回收——**按原 id 重建**（此前误用 createSession 生成随机
      // id 再改写，会在每次重连上多记一条假 "session created"，是刷屏的根源）
      session = this.makeSession(sessionId, 'tap')
      this.registerSession(session)
      console.log(`[SSE Hub] session resumed: ${sessionId} (${this.sessions.size} active)`)
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    // EventSource 重连时旧连接的 close 可能还没到达：立即 abort 旧流释放其队列，
    // 否则旧 TransformStream 会一直被旧 HTTP 响应引用而滞留
    this.abortWriter(session.writer)
    session.writer = writer
    session.lastHeartbeat = Date.now()

    // 发送 connected 事件
    const event: ServerEvent = { type: 'connected', payload: { sessionId }, timestamp: Date.now() }
    void this.sendEvent(writer, event)

    return { session, stream: readable }
  }

  /**
   * 传输层断开：仅**解绑**该连接的 writer 与输出回调，**不销毁会话**。
   *
   * 会话的语义是「客户端逻辑连接」（由 POST /session 建立、由保活 ping 续命、由 TTL 回收），
   * SSE 流只是它的传输载体——EventSource 会自动重连并复用同一 sessionId。若在流 close 时
   * 销毁会话，每次瞬时断连都会上演「销毁 → 重连复活」的刷屏，并丢失会话状态
   * （mode / isOutputEnabled / recording）。
   *
   * 解绑后 writer 为空 → 心跳/输出广播自动跳过，不再有「死会话被灌音频」的内存增长；
   * 真正离线的会话由 reapStaleSessions 在 TTL 后清掉（届时按既有逻辑释放听写）。
   *
   * 仅当断开的连接仍是当前连接时才解绑——EventSource 可能在旧连接的 close 事件到达前
   * 就已建好新连接，此时不能误清新连接的 writer。
   */
  detachStream(id: string, writer: WritableStreamDefaultWriter<Uint8Array> | null): void {
    const session = this.sessions.get(id)
    if (!session || session.writer !== writer) return
    session.writer = null
    session.onOutputAudio = null
    session.lastHeartbeat = Date.now()
    // 连接已断开：abort 丢弃流内积压并释放队列，不等 GC（否则重连频繁时旧流滞留）
    this.abortWriter(writer)
  }

  // ─── 状态更新 ───

  updateState(sessionId: string, update: StateUpdateRequest): SSESession | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) return undefined
    if (update.recording !== undefined) session.state.recording = update.recording
    if (update.mode !== undefined) session.state.mode = update.mode
    if (update.isOutputEnabled !== undefined) session.state.isOutputEnabled = update.isOutputEnabled
    const prevDictation = session.state.dictation
    if (update.dictation !== undefined) session.state.dictation = update.dictation
    if (update.audioLevel !== undefined) session.state.audioLevel = update.audioLevel
    session.lastHeartbeat = Date.now()

    // 听写态翻转 → 通知联动回调（重复上报同值不触发）
    if (update.dictation !== undefined && update.dictation !== prevDictation) {
      this.onDictationChange?.(update.dictation, sessionId, 'toggle')
    }

    // 广播状态变化给其他客户端
    this.notifyListeners(sessionId, {
      type: 'peer_state',
      payload: session.state,
      timestamp: Date.now(),
    })

    return session
  }

  // ─── 音频中继 ───

  relayAudio(sessionId: string, data: string, sampleRate: number, timestamp: number, sequence: number) {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.lastHeartbeat = Date.now()
    if (session.onAudioChunk) {
      session.onAudioChunk({ data, sampleRate, timestamp, sequence })
    }
    return true
  }

  /** 将系统输出音频推给所有开启输出的客户端 */
  broadcastOutputAudio(data: Buffer) {
    const payload = data.buffer as ArrayBuffer
    for (const session of this.sessions.values()) {
      if (!session.state.isOutputEnabled || !session.onOutputAudio) continue
      const writer = session.writer
      if (!writer) continue
      // 背压门控：下行是实时音频，手机网络/后台冻结导致消费端跟不上时宁可丢块，
      // 也不能让未 await 的 write() 在 TransformStream 队列里无界堆积
      //（desiredSize <= 0 表示上一块尚未被消费端消化）。
      if (writer.desiredSize !== null && writer.desiredSize <= 0) continue
      session.onOutputAudio(payload)
    }
  }

  // ─── 事件监听 ───

  on(cb: HubEventListener) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  // ─── 内部方法 ───

  private async sendEvent(writer: WritableStreamDefaultWriter<Uint8Array>, event: ServerEvent) {
    try {
      const line = `data: ${JSON.stringify(event)}\n\n`
      const enc = new TextEncoder()
      await writer.write(enc.encode(line))
    } catch {
      // 客户端已断开——安静处理
    }
  }

  private notifyListeners(sessionId: string, event: ServerEvent) {
    for (const cb of this.listeners) {
      try { cb(sessionId, event) } catch { /* noop */ }
    }
  }

  private sendHeartbeats() {
    const event: ServerEvent = { type: 'heartbeat', timestamp: Date.now() }
    for (const [id, session] of this.sessions) {
      if (session.writer) {
        void this.sendEvent(session.writer, event).catch(() => {
          this.destroySession(id)
        })
      }
    }
  }

  /** 回收空闲超时会话——断连检测在开发代理（vite http-proxy）后不可靠，以 TTL 兜底 */
  private reapStaleSessions() {
    const now = Date.now()
    for (const [id, session] of this.sessions) {
      const idleMs = now - session.lastHeartbeat
      if (idleMs > SSE_SESSION_TTL_MS) {
        console.log(`[SSE Hub] session reaped (idle ${Math.round(idleMs / 1000)}s): ${id}`)
        this.destroySession(id)
      }
    }
  }

  /** 立即终止 writer 并丢弃其队列（断连/被新连接取代）——不等待数据排空 */
  private abortWriter(writer: WritableStreamDefaultWriter<Uint8Array> | null): void {
    if (!writer) return
    try {
      void writer.abort().catch(() => { /* 流已关闭/已断开 */ })
    } catch { /* noop */ }
  }

  private async closeWriter(writer: WritableStreamDefaultWriter<Uint8Array> | null, _id: string) {
    if (!writer) return
    try {
      await writer.close()
    } catch {
      try { writer.releaseLock() } catch { /* noop */ }
    }
  }
}

/** 全局单例 */
export const sseHub = new SSEHub()