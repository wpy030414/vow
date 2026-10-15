// SSE 连接池管理

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

let sessionCounter = 0

export class SSEHub {
  private sessions = new Map<string, SSESession>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reapTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<HubEventListener>()

  /** 听写联动回调——某会话的听写态翻转时触发；会话销毁时若听写仍开着则强制释放 */
  onDictationChange: ((active: boolean, sessionId: string, reason: 'toggle' | 'release') => void) | null = null

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

  createSession(deviceName?: string, mode: RecordMode = 'tap'): SSESession {
    const id = `vow-${Date.now()}-${++sessionCounter}`
    const now = Date.now()
    const session: SSESession = {
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
    this.sessions.set(id, session)
    console.log(`[SSE Hub] session created: ${id} (${this.sessions.size} active)`)
    return session
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
      session = this.createSession()
      // 覆盖自动 ID 为客户端传入的
      this.sessions.delete(session.id)
      session.id = sessionId
      this.sessions.set(sessionId, session)
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    session.writer = writer
    session.lastHeartbeat = Date.now()

    // 发送 connected 事件
    const event: ServerEvent = { type: 'connected', payload: { sessionId }, timestamp: Date.now() }
    void this.sendEvent(writer, event)

    return { session, stream: readable }
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
    for (const session of this.sessions.values()) {
      if (session.state.isOutputEnabled && session.onOutputAudio) {
        session.onOutputAudio(data.buffer as ArrayBuffer)
      }
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