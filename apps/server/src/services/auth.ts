// auth.ts — 配对令牌鉴权：令牌持久化 + Auth 中间件 + 常量时间比对
//
// 设计（详见 docs/DECISIONS.md A13）：
// - 秘密的本质是「物理接近」：宿主机终端二维码携带配对令牌（?t=），扫码后经
//   POST /api/pair 换取 HttpOnly cookie——同源 fetch / EventSource 自动携带，
//   客户端网络层零改动（原生 EventSource 无法自定义 header，这是 cookie 路线的关键理由）
// - 令牌持久于 .vow/pairing-token（gitignored）：重启 / tsx watch 不丢配对；
//   轮换 = pnpm pair --rotate（全部旧 cookie 立即失效）
// - 中间件接受 cookie 或 Authorization: Bearer（CLI 冒烟通道）

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'

export const AUTH_COOKIE_NAME = 'vow_token'

/** cookie 有效期 180 天——轮换权在宿主端（pnpm pair --rotate），过期仅需重扫一次 */
export const AUTH_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60

const TOKEN_FILE = 'pairing-token'

// ─── 令牌持久化 ───

/** 读取或生成配对令牌（<vowDir>/pairing-token；rotate=true 强制轮换） */
export function loadOrCreateToken(vowDir: string, opts: { rotate?: boolean } = {}): string {
  const file = join(vowDir, TOKEN_FILE)
  if (!opts.rotate && existsSync(file)) {
    const token = readFileSync(file, 'utf-8').trim()
    if (token) return token
    // 空文件按损坏处理，落回重新生成
  }
  const token = randomBytes(16).toString('base64url') // 128 bit；base64url 字符集对 URL/cookie 均安全
  mkdirSync(vowDir, { recursive: true })
  writeFileSync(file, token + '\n', { mode: 0o600 }) // Windows 上 mode 语义有限，尽力而为
  return token
}

// ─── 常量时间比对 ───

/** 先散列再比对：摘要长度恒为 32B，规避 timingSafeEqual 对长度差异的早退行为 */
export function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ─── 中间件 ───

/** 校验 cookie 或 Authorization: Bearer；失败统一 401 JSON */
export function createAuthMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('Authorization')
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined
    const candidate = getCookie(c, AUTH_COOKIE_NAME) ?? bearer
    if (candidate && tokenEquals(candidate, token)) {
      await next()
      return
    }
    return c.json({ error: 'unauthorized', hint: '在宿主机运行 pnpm pair 扫码配对' }, 401)
  }
}
