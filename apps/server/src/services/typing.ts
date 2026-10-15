// typing — 转写文本注入：KEYEVENTF_UNICODE 逐码元打入焦点窗口（完全绕过输入法）

import { loadKeybdEvent, KEYEVENTF_UNICODE, KEYEVENTF_KEYUP, type KeybdEventFn } from './win32-keys'

/** 逐键间隔（部分应用对高频注入会丢字） */
const KEY_INTERVAL_MS = Number(process.env.VOW_TYPE_INTERVAL_MS || 8)

export interface TypeTextOptions {
  intervalMs?: number
  /** 测试注入；缺省用生产 keybd_event */
  keybd?: KeybdEventFn | null
}

/**
 * 把文本逐 UTF-16 码元注入当前焦点窗口。
 * Unicode 注入模式下 wVk 必须为 0、字符码放 wScan；代理对按码元逐个发（应用自行合成）。
 * @returns 是否成功注入（无原生注入能力时 false）
 */
export async function typeText(text: string, opts: TypeTextOptions = {}): Promise<boolean> {
  if (!text) return true
  const keybd = opts.keybd !== undefined ? opts.keybd : loadKeybdEvent()
  if (!keybd) return false
  const interval = opts.intervalMs ?? KEY_INTERVAL_MS

  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    keybd(0, unit, KEYEVENTF_UNICODE, 0)
    keybd(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0)
    if (interval > 0 && i < text.length - 1) {
      await new Promise((r) => setTimeout(r, interval))
    }
  }
  return true
}
