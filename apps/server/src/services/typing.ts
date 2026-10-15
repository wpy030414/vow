// typing — 转写文本注入：SendInput(KEYEVENTF_UNICODE) 逐码元打入焦点窗口（完全绕过输入法）
//
// 注意：不能用 keybd_event（bScan 是 BYTE，UTF-16 码元会被截断 → 中文乱码），
// 必须走 SendInput 的 WORD 位 wScan（见 win32-keys.loadUnicodeSender）

import { loadUnicodeSender, type SendUnicodeFn } from './win32-keys'

/** 逐键间隔（部分应用对高频注入会丢字） */
const KEY_INTERVAL_MS = Number(process.env.VOW_TYPE_INTERVAL_MS || 8)

export interface TypeTextOptions {
  intervalMs?: number
  /** 测试注入；缺省用生产 SendInput */
  sender?: SendUnicodeFn | null
}

/**
 * 把文本逐 UTF-16 码元注入当前焦点窗口。
 * 代理对按码元逐个发（应用自行合成）。
 * @returns 是否成功注入（无原生注入能力时 false）
 */
export async function typeText(text: string, opts: TypeTextOptions = {}): Promise<boolean> {
  if (!text) return true
  const send = opts.sender !== undefined ? opts.sender : loadUnicodeSender()
  if (!send) return false
  const interval = opts.intervalMs ?? KEY_INTERVAL_MS

  for (let i = 0; i < text.length; i++) {
    send(text.charCodeAt(i))
    if (interval > 0 && i < text.length - 1) {
      await new Promise((r) => setTimeout(r, interval))
    }
  }
  return true
}
