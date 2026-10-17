import { describe, it, expect } from 'vitest'
import { createKeyRoutes } from './keys'
import type { NativeKeys } from '../services/win32-keys'

/** 注入替身：记录按键调用，不触碰真实 user32 */
function stubKeys(supported = true) {
  const pressed: string[] = []
  const keys: NativeKeys = {
    supported,
    chord: (win, vk) => { pressed.push(`${win ? 'win+' : ''}${vk}`) },
  }
  return { keys, pressed }
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
    const { keys, pressed } = stubKeys()
    const app = createKeyRoutes(keys)

    expect(await (await press(app, 'backspace')).json()).toEqual({ ok: true })
    expect(await (await press(app, 'enter')).json()).toEqual({ ok: true })
    expect(pressed).toEqual(['8', '13'])
  })

  it('非白名单 key 返回 400 且不注入', async () => {
    const { keys, pressed } = stubKeys()
    const app = createKeyRoutes(keys)

    for (const bad of ['toString', '__proto__', 'space', 1, null]) {
      expect((await press(app, bad)).status).toBe(400)
    }
    expect(pressed).toEqual([])
  })

  it('平台不支持时返回 ok:false', async () => {
    const { keys } = stubKeys(false)
    const app = createKeyRoutes(keys)

    expect(await (await press(app, 'enter')).json()).toEqual({ ok: false })
  })
})
