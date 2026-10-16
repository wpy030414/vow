// SSE 路由：stream / session / audio / state / info

import { Hono } from 'hono'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sseHub } from '../services/sse-hub'
import { resolveEngineConfig } from '../services/dictation'
import type {
  ConnectRequest, ConnectResponse,
  AudioChunk, AudioUploadResponse,
  StateUpdateRequest,
  ConnectionInfo,
} from '@vow/shared/types'
import { SSE_HEARTBEAT_MS, LOOPBACK_SAMPLE_RATE, LOOPBACK_CHANNELS } from '@vow/shared/constants'

export const sseRoutes = new Hono()

// ─── POST /api/sse/session — 创建会话 ───

sseRoutes.post('/session', async (c) => {
  const body = await c.req.json<ConnectRequest>().catch(() => ({ mode: 'tap' } as ConnectRequest))
  const session = sseHub.createSession(body.deviceName, body.mode)
  const res: ConnectResponse = {
    sessionId: session.id,
    serverTime: Date.now(),
  }
  return c.json(res)
})

// ─── GET /api/sse/stream?sessionId=xxx — 事件流 ───

sseRoutes.get('/stream', async (c) => {
  const sessionId = c.req.query('sessionId')
  if (!sessionId) {
    return c.json({ error: 'Missing sessionId query parameter' }, 400)
  }
  // 注意：不做 404 预检查——客户端 EventSource 断线自动重连时携带原 sessionId，
  // 会话可能已被 TTL 回收，getOrCreateStream 会按原 id 复活（重建 writer）

  const { session, stream } = sseHub.getOrCreateStream(sessionId)

  // 断连检测：@hono/node-server 不向 TransformStream 传播取消，writer.write() 在客户端
  // 离开后不会失败 → 心跳清理永不触发，开着输出的死会话会被持续灌入音频导致内存增长。
  // 故监听底层 HTTP 响应的 close 事件。但**只解绑本连接的 writer，不销毁会话**：
  // 会话是逻辑连接（EventSource 会自动重连并复用同一 sessionId），流 close 时销毁会话
  // 会让每次瞬时断连演变成「销毁→复活」刷屏并丢状态；真正离线的会话由 TTL 兜底回收。
  // 捕获本连接的 writer 作身份凭据——旧连接的 close 可能晚于新连接建立，不可误清新 writer。
  const myWriter = session.writer
  const nodeEnv = c.env as Partial<{ incoming: IncomingMessage; outgoing: ServerResponse }>
  const detachOnce = (() => {
    let fired = false
    return () => {
      if (fired) return
      fired = true
      sseHub.detachStream(sessionId, myWriter)
    }
  })()
  nodeEnv.outgoing?.on('close', detachOnce)
  nodeEnv.incoming?.on('close', detachOnce)

  // 注册输出音频回调：系统音频 → SSE push 给手机
  session.onOutputAudio = (audioData: ArrayBuffer) => {
    if (!session.writer) return
    const chunks = new Uint8Array(audioData)
    let binary = ''
    for (let i = 0; i < chunks.byteLength; i++) {
      binary += String.fromCharCode(chunks[i])
    }
    const base64 = btoa(binary)
    const event = {
      type: 'output_audio' as const,
      payload: { data: base64, sampleRate: LOOPBACK_SAMPLE_RATE, channels: LOOPBACK_CHANNELS, timestamp: Date.now() },
      timestamp: Date.now(),
    }
    const line = `data: ${JSON.stringify(event)}\n\n`
    const enc = new TextEncoder()
    session.writer!.write(enc.encode(line)).catch(() => { /* client disconnected */ })
  }

  return c.newResponse(
    stream,
    200,
    {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  )
})

// ─── POST /api/sse/audio — 上传音频块 ───

sseRoutes.post('/audio', async (c) => {
  const chunk = await c.req.json<AudioChunk>().catch(() => null)
  if (!chunk || !chunk.sessionId || !chunk.data) {
    return c.json({ error: 'Invalid audio chunk' }, 400)
  }
  const ok = sseHub.relayAudio(chunk.sessionId, chunk.data, chunk.sampleRate, chunk.timestamp, chunk.sequence)
  if (!ok) return c.json({ error: 'Session not found' }, 404)
  const resp: AudioUploadResponse = { received: chunk.sequence }
  return c.json(resp)
})

// ─── POST /api/sse/ping?sessionId=xxx — 客户端保活 ───

sseRoutes.post('/ping', (c) => {
  const sessionId = c.req.query('sessionId')
  if (!sessionId) return c.json({ error: 'Missing sessionId query parameter' }, 400)
  const ok = sseHub.touch(sessionId)
  if (!ok) return c.json({ error: 'Session not found' }, 404)
  return c.json({ ok: true })
})

// ─── POST /api/sse/state — 客户端状态更新 ───

sseRoutes.post('/state', async (c) => {
  const sessionId = c.req.query('sessionId')
  if (!sessionId) return c.json({ error: 'Missing sessionId' }, 400)
  const update = await c.req.json<StateUpdateRequest>().catch(() => ({}))
  const updated = sseHub.updateState(sessionId, update)
  if (!updated) return c.json({ error: 'Session not found' }, 404)
  return c.json(updated.state)
})

// ─── GET /api/sse/info — 连接信息 ───

sseRoutes.get('/info', (c) => {
  const info: ConnectionInfo = {
    ...sseHub.getConnectionInfo(),
    dictationEngine: resolveEngineConfig().engine,
  }
  return c.json(info)
})