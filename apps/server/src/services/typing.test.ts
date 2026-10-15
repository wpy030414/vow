import { describe, it, expect } from 'vitest'
import { typeText } from './typing'

describe('typeText — SendInput Unicode 注入', () => {
  it('逐 UTF-16 码元发送（含中文）', async () => {
    const units: number[] = []
    await typeText('a你', { sender: (u) => units.push(u), intervalMs: 0 })
    expect(units).toEqual([0x61, 0x4f60])
  })

  it('代理对按两个码元发送', async () => {
    const units: number[] = []
    await typeText('😀', { sender: (u) => units.push(u), intervalMs: 0 }) // U+1F600 → D83D DE00
    expect(units).toEqual([0xd83d, 0xde00])
  })

  it('空文本直接成功；无注入能力返回 false', async () => {
    expect(await typeText('', { sender: null })).toBe(true)
    expect(await typeText('x', { sender: null })).toBe(false)
  })
})
