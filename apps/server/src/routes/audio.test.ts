// audio.test.ts — Eva 形态下输出捕获（耳返）的路由级硬拒绝

import { describe, it, expect } from 'vitest'
import { createAudioRoutes } from './audio'

function enableOutput(app: ReturnType<typeof createAudioRoutes>, sessionId = 's-eva') {
  return app.request(`/output?sessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
}

describe('POST /api/audio/output — qwennote-eva', () => {
  it('开启请求直接 400，不触碰会话与设备', async () => {
    const app = createAudioRoutes({ appMode: 'qwennote-eva' })
    const resp = await enableOutput(app)
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ error: 'Output capture is disabled in qwennote-eva mode' })
  })
})

describe('POST /api/audio/output — codex-micro', () => {
  it('会话不存在时维持既有 404 语义（不因工厂化改变）', async () => {
    const app = createAudioRoutes({ appMode: 'codex-micro' })
    expect((await enableOutput(app)).status).toBe(404)
  })
})
