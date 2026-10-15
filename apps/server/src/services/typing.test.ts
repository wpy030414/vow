import { describe, it, expect } from 'vitest'
import { typeText } from './typing'

const KEYEVENTF_UNICODE = 0x0004
const KEYEVENTF_KEYUP = 0x0002

describe('typeText — Unicode 注入', () => {
  it('逐 UTF-16 码元 down/up 配对（wVk=0，字符码在 wScan）', async () => {
    const calls: Array<[number, number, number]> = []
    const keybd = (vk: number, scan: number, flags: number) => calls.push([vk, scan, flags])
    await typeText('a你', { keybd, intervalMs: 0 })
    expect(calls).toEqual([
      [0, 0x61, KEYEVENTF_UNICODE],
      [0, 0x61, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP],
      [0, 0x4f60, KEYEVENTF_UNICODE],
      [0, 0x4f60, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP],
    ])
  })

  it('代理对按两个码元发送', async () => {
    const calls: Array<[number, number, number]> = []
    const keybd = (vk: number, scan: number, flags: number) => calls.push([vk, scan, flags])
    await typeText('😀', { keybd, intervalMs: 0 }) // U+1F600 → D83D DE00
    expect(calls.map((c) => c[1])).toEqual([0xd83d, 0xd83d, 0xde00, 0xde00])
  })

  it('空文本直接成功；无注入能力返回 false', async () => {
    expect(await typeText('', { keybd: null })).toBe(true)
    expect(await typeText('x', { keybd: null })).toBe(false)
  })
})
