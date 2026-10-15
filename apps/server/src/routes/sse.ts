// SSE 路由：stream / session / audio / state / info

import { Hono } from 'hono'
import { sseHub } from '../services/sse-hub'
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
  if (!sseHub.getSession(sessionId)) {
    return c.json({ error: 'Session not found; create one via POST /api/sse/session first' }, 404)
  }

  const { session, stream } = sseHub.getOrCreateStream(sessionId)

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
  const info: ConnectionInfo = sseHub.getConnectionInfo()
  return c.json(info)
})