// 音频设备管理 API

import { Hono } from 'hono'
import { virtualAudio } from '../services/virtual-audio'
import { sseHub } from '../services/sse-hub'
import type { AudioDeviceStatus, DeviceListResponse } from '@vow/shared/types'

export const audioRoutes = new Hono()

// ─── GET /api/audio/devices ───

audioRoutes.get('/devices', (c) => {
  const status: AudioDeviceStatus = virtualAudio.getDeviceStatus()
  // 枚举 PortAudio 可见设备
  const list: DeviceListResponse = { status, devices: [] }
  return c.json(list)
})

// ─── POST /api/audio/output — 控制输出捕获 ───

audioRoutes.post('/output', async (c) => {
  const sessionId = c.req.query('sessionId')
  if (!sessionId) {
    return c.json({ error: 'Missing sessionId' }, 400)
  }

  const body = await c.req.json<{ enabled: boolean }>().catch(() => ({ enabled: false }))

  if (body.enabled) {
    // 确认 session 存在且开启了输出
    const session = sseHub.getSession(sessionId)
    if (!session) return c.json({ error: 'Session not found' }, 404)

    // 标记输出开启
    session.state.isOutputEnabled = true

    // 如果 capture 还没开，启动它
    if (!virtualAudio.getDeviceStatus().outputActive) {
      virtualAudio.startOutput()
    }
  } else {
    const session = sseHub.getSession(sessionId)
    if (session) {
      session.state.isOutputEnabled = false
    }

    // 如果没有其他 session 需要输出，停止 capture
    const anyOutput = Array.from(sseHub.getConnectionInfo().sessions).some((sid) => {
      const s = sseHub.getSession(sid)
      return s?.state.isOutputEnabled
    })
    if (!anyOutput) {
      virtualAudio.stopOutput()
    }
  }

  return c.json({ ok: true, state: virtualAudio.getDeviceStatus() })
})

// ─── GET /api/audio/status — 当前设备状态快照 ───

audioRoutes.get('/status', (c) => {
  return c.json(virtualAudio.getDeviceStatus())
})