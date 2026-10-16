// pair 路由：POST /api/pair —— 携带配对令牌换取 HttpOnly cookie
//
// ⚠ 必须在 index.ts 中注册于鉴权中间件【之前】（Hono 的 app.use 只作用于其后注册的路由）

import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { AUTH_COOKIE_MAX_AGE_S, AUTH_COOKIE_NAME, tokenEquals } from '../services/auth'

/** getToken 为热加载回调——pnpm pair --rotate 写入新令牌后无需重启服务 */
export function createPairRoutes(opts: { token: string; getToken?: () => string }): Hono {
  const getToken = opts.getToken ?? (() => opts.token)
  const routes = new Hono()

  routes.post('/pair', async (c) => {
    const body = await c.req.json<{ token?: unknown }>().catch(() => null)
    const candidate = typeof body?.token === 'string' ? body.token : ''
    const currentToken = getToken()
    if (!candidate || !tokenEquals(candidate, currentToken)) {
      return c.json({ error: 'invalid token' }, 401)
    }
    // Secure 硬编码：LAN 手机访问本就是 HTTPS（自签证书，getUserMedia 安全上下文的前提）
    setCookie(c, AUTH_COOKIE_NAME, currentToken, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      maxAge: AUTH_COOKIE_MAX_AGE_S,
    })
    return c.json({ ok: true })
  })

  return routes
}
