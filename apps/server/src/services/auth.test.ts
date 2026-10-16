// auth 测试：令牌服务 + 中间件 + 配对路由（注入式，零 vi.mock，沿用仓库惯例）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { AUTH_COOKIE_NAME, createAuthMiddleware, createTokenStore, loadOrCreateToken, tokenEquals } from './auth'
import { createPairRoutes } from '../routes/pair'

const TOKEN = 'test-token-0123456789abcdef'

describe('loadOrCreateToken', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vow-auth-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('首次生成 128bit base64url 令牌并持久化；二次调用返回同一令牌（重启不换码）', () => {
    const t1 = loadOrCreateToken(dir)
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(loadOrCreateToken(dir)).toBe(t1)
  })

  it('rotate=true 强制轮换，且其后以新值为准', () => {
    const t1 = loadOrCreateToken(dir)
    const t2 = loadOrCreateToken(dir, { rotate: true })
    expect(t2).not.toBe(t1)
    expect(loadOrCreateToken(dir)).toBe(t2)
  })

  it('空文件按损坏处理，落回重新生成', () => {
    const t1 = loadOrCreateToken(dir)
    writeFileSync(join(dir, 'pairing-token'), '')
    const t2 = loadOrCreateToken(dir)
    expect(t2).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(t2).not.toBe(t1)
  })
})

describe('tokenEquals', () => {
  it('相同为真、不同为假、长度不同也为假', () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true)
    expect(tokenEquals(TOKEN, TOKEN + 'x')).toBe(false)
    expect(tokenEquals(TOKEN, 'A'.repeat(TOKEN.length))).toBe(false)
    expect(tokenEquals('', TOKEN)).toBe(false)
  })
})

describe('createAuthMiddleware（app 级顺序语义）', () => {
  function appWith(token: string) {
    const app = new Hono()
    app.get('/api/health', (c) => c.json({ status: 'ok' })) // 中间件之前注册 → 免鉴权
    app.use('/api/*', createAuthMiddleware(() => token))
    app.get('/api/secret', (c) => c.json({ ok: true }))
    return app
  }

  it('无凭证 401；正确 cookie 放行；错误 cookie 401', async () => {
    const app = appWith(TOKEN)
    expect((await app.request('/api/secret')).status).toBe(401)
    expect((await app.request('/api/secret', { headers: { Cookie: `${AUTH_COOKIE_NAME}=${TOKEN}` } })).status).toBe(200)
    expect((await app.request('/api/secret', { headers: { Cookie: `${AUTH_COOKIE_NAME}=wrong` } })).status).toBe(401)
  })

  it('Authorization: Bearer 放行（CLI 冒烟通道）', async () => {
    const app = appWith(TOKEN)
    expect((await app.request('/api/secret', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    expect((await app.request('/api/secret', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401)
  })

  it('中间件之前注册的路由不受影响（/api/health 免鉴权）', async () => {
    const app = appWith(TOKEN)
    expect((await app.request('/api/health')).status).toBe(200)
  })
})

describe('createPairRoutes（与中间件的注册顺序语义）', () => {
  function appWith(token: string) {
    const app = new Hono()
    // 与 index.ts 相同的接线：pair 先注册（免鉴权），中间件其后
    app.route('/api', createPairRoutes({ token }))
    app.use('/api/*', createAuthMiddleware(() => token))
    app.get('/api/secret', (c) => c.json({ ok: true }))
    return app
  }

  function pair(app: Hono, token: string) {
    return app.request('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
  }

  it('正确令牌 → 200 + HttpOnly/Secure/SameSite=Strict cookie（无需既有凭证）', async () => {
    const app = appWith(TOKEN)
    const resp = await pair(app, TOKEN)
    expect(resp.status).toBe(200)
    const setCookie = resp.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain(`${AUTH_COOKIE_NAME}=${TOKEN}`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
  })

  it('错误令牌 → 401 且不下发 cookie', async () => {
    const app = appWith(TOKEN)
    const resp = await pair(app, 'wrong')
    expect(resp.status).toBe(401)
    expect(resp.headers.get('Set-Cookie')).toBeNull()
  })

  it('缺令牌 / 非 JSON body → 401', async () => {
    const app = appWith(TOKEN)
    expect((await app.request('/api/pair', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    })).status).toBe(401)
  })

  it('拿到的 cookie 可通行受保护路由（端到端闭环）', async () => {
    const app = appWith(TOKEN)
    const resp = await pair(app, TOKEN)
    const cookie = (resp.headers.get('Set-Cookie') ?? '').split(';')[0] // name=value
    expect((await app.request('/api/secret', { headers: { Cookie: cookie } })).status).toBe(200)
  })
})

describe('createTokenStore（热加载：fs.watch 监听文件变化）', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vow-auth-hot-'))
    file = join(dir, 'pairing-token')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('初始读取文件令牌', () => {
    writeFileSync(file, 'hot-token-init', 'utf-8')
    const store = createTokenStore(dir)
    expect(store.token).toBe('hot-token-init')
    store.close()
  })

  it('文件变化后 token 返回新值', async () => {
    writeFileSync(file, 'hot-token-v1', 'utf-8')
    const store = createTokenStore(dir)
    expect(store.token).toBe('hot-token-v1')

    writeFileSync(file, 'hot-token-v2', 'utf-8')
    for (let i = 0; i < 20 && store.token === 'hot-token-v1'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(store.token).toBe('hot-token-v2')
    store.close()
  })

  it('热加载后新令牌可配对，旧令牌 401（端到端）', async () => {
    writeFileSync(file, 'hot-old', 'utf-8')
    const store = createTokenStore(dir)

    const app = new Hono()
    app.route('/api', createPairRoutes({ token: store.token, getToken: () => store.token }))
    app.use('/api/*', createAuthMiddleware(() => store.token))
    app.get('/api/secret', (c) => c.json({ ok: true }))

    // 旧令牌可通行
    expect((await app.request('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'hot-old' }),
    })).status).toBe(200)

    // 轮换
    writeFileSync(file, 'hot-new', 'utf-8')
    for (let i = 0; i < 20 && store.token === 'hot-old'; i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(store.token).toBe('hot-new')

    // 新令牌可配对
    expect((await app.request('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'hot-new' }),
    })).status).toBe(200)

    // 旧令牌已失效
    expect((await app.request('/api/secret', {
      headers: { Cookie: `${AUTH_COOKIE_NAME}=hot-old` } },
    )).status).toBe(401)

    store.close()
  })
})
