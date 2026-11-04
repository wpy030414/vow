// sse.test.ts — Eva 形态在会话/状态/信息路由上的硬约束（经真实 sseHub 走全链路）

import { describe, it, expect, afterEach } from 'vitest'
import { createSseRoutes } from './sse'
import { sseHub } from '../services/sse-hub'

const app = createSseRoutes({ appMode: 'qwennote-eva' })

/** 清理单例 hub 中本组测试建立的会话 */
afterEach(() => {
  for (const id of sseHub.getConnectionInfo().sessions) sseHub.destroySession(id)
})

/** 建一个会话，返回其 id */
async function createSession(): Promise<string> {
  const resp = await app.request('/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceName: 't', mode: 'hold' }),
  })
  const body = (await resp.json()) as { sessionId: string; appMode?: string }
  expect(body.appMode).toBe('qwennote-eva')
  return body.sessionId
}

/** 上报一次状态 */
async function pushState(sessionId: string, update: Record<string, unknown>) {
  const resp = await app.request(`/state?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  return { status: resp.status, state: (await resp.json()) as Record<string, unknown> }
}

describe('qwennote-eva 路由硬约束', () => {
  it('POST /session：请求 hold 也落 tap', async () => {
    const sessionId = await createSession()
    expect(sseHub.getSession(sessionId)?.state.mode).toBe('tap')
  })

  it('POST /state：dictation 被改写为录音态，mode/耳返被压制', async () => {
    const sessionId = await createSession()

    // 客户端伪造「录音中但听写关、hold、耳返开」——服务端全部压回
    const started = await pushState(sessionId, {
      recording: true,
      mode: 'hold',
      isOutputEnabled: true,
      dictation: false,
    })
    expect(started.status).toBe(200)
    expect(started.state).toMatchObject({
      mode: 'tap',
      isOutputEnabled: false,
      dictation: true,
      recording: true,
    })

    // 停录 → dictation 归 false（ASR 收尾触发）
    const stopped = await pushState(sessionId, { recording: false, dictation: true })
    expect(stopped.state.dictation).toBe(false)
  })

  it('GET /info：携带 appMode', async () => {
    const resp = await app.request('/info')
    expect(((await resp.json()) as { appMode?: string }).appMode).toBe('qwennote-eva')
  })
})
