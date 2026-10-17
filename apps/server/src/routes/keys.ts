// 宿主辅助键 API —— 手机端退格 / 回车注入宿主机焦点窗口

import { Hono } from 'hono'
import { loadNativeKeys, VK_BACK, VK_RETURN, type NativeKeys } from '../services/win32-keys'
import type { HostKey, KeyPressRequest, KeyPressResponse } from '@vow/shared/types'

/** 白名单映射：类型约束与运行时校验共用同一来源（非法 key 不得落表） */
const VK_BY_KEY: Record<HostKey, number> = {
  backspace: VK_BACK,
  enter: VK_RETURN,
}

/**
 * 按键注入路由。`keys` 可注入替身（测试）；缺省使用生产 user32 实现。
 */
export function createKeyRoutes(keys: NativeKeys = loadNativeKeys()): Hono {
  const routes = new Hono()

  // ─── POST /press — 注入一次辅助键 ───

  routes.post('/press', async (c) => {
    const body = await c.req.json<KeyPressRequest>().catch(() => null)
    if (!body || (body.key !== 'backspace' && body.key !== 'enter')) {
      return c.json({ error: 'Invalid key' }, 400)
    }
    keys.chord(false, VK_BY_KEY[body.key])
    if (keys.supported) {
      console.log(`[Keys] ${body.key} injected`)
    } else {
      console.warn(`[Keys] ${body.key} 注入不可用（非 win32 或 user32 加载失败）`)
    }
    const res: KeyPressResponse = { ok: keys.supported }
    return c.json(res)
  })

  return routes
}
