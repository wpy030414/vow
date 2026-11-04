import { describe, it, expect } from 'vitest'
import { createKeyRoutes } from './keys'
import type { SendUnicodeFn } from '../services/win32-keys'

/** 注入替身：记录注入码元，不触碰真实 user32 */
function stubKeys(supported = true) {
  const pressed: number[] = []
  const send: SendUnicodeFn | null = supported
    ? (unit) => {
        pressed.push(unit)
      }
    : null
  return { send, pressed }
}

function press(app: ReturnType<typeof createKeyRoutes>, key: unknown) {
  return app.request('/press', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
}

describe('POST /api/keys/press', () => {
  it('backspace / enter 映射到对应 VK 码并注入', async () => {
    const { send, pressed } = stubKeys()
    const app = createKeyRoutes(send)

    expect(await (await press(app, 'backspace')).json()).toEqual({ ok: true })
    expect(await (await press(app, 'enter')).json()).toEqual({ ok: true })
    expect(pressed).toEqual([0x08, 0x0d])
  })

  it('非白名单 key 返回 400 且不注入', async () => {
    const { send, pressed } = stubKeys()
    const app = createKeyRoutes(send)

    for (const bad of ['toString', '__proto__', 'space', 1, null]) {
      expect((await press(app, bad)).status).toBe(400)
    }
    expect(pressed).toEqual([])
  })

  it('平台不支持时返回 ok:false', async () => {
    const { send } = stubKeys(false)
    const app = createKeyRoutes(send)

    expect(await (await press(app, 'enter')).json()).toEqual({ ok: false })
  })
})
