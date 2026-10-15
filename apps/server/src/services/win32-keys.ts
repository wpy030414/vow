// win32-keys — 原生按键注入底层（koffi → user32 keybd_event）
// dictation（快捷键注入）与 typing（Unicode 文本注入）共用

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ─── Win32 常量 ───

export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const VK_LWIN = 0x5b
export const VK_H = 0x48

export type KeybdEventFn = (bVk: number, bScan: number, dwFlags: number, dwExtraInfo: number) => void

let cached: KeybdEventFn | null | undefined // undefined = 未尝试加载

/** 加载 user32 keybd_event（非 win32 或加载失败返回 null，结果缓存） */
export function loadKeybdEvent(): KeybdEventFn | null {
  if (cached !== undefined) return cached
  if (process.platform !== 'win32') {
    cached = null
    return null
  }
  try {
    // koffi 预编译二进制随包分发，此处 createRequire 保证 tsup 打包后仍从 server 依赖解析
    const koffi = require('koffi') as {
      load: (dll: string) => { func: (sig: string) => KeybdEventFn }
    }
    const user32 = koffi.load('user32.dll')
    cached = user32.func(
      'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)',
    )
  } catch (err) {
    console.warn('[win32-keys] 原生按键注入不可用：', err instanceof Error ? err.message : err)
    cached = null
  }
  return cached
}

export interface NativeKeys {
  supported: boolean
  /** 注入一次按键（可选 Win 修饰键和弦），自动配对按下/抬起 */
  chord(winModifier: boolean, vk: number): void
}

/** 生产实现：koffi + user32 keybd_event（测试传入替身） */
export function loadNativeKeys(): NativeKeys {
  const keybd = loadKeybdEvent()
  if (!keybd) return { supported: false, chord: () => {} }
  return {
    supported: true,
    chord(winModifier, vk) {
      if (winModifier) keybd(VK_LWIN, 0, 0, 0)
      keybd(vk, 0, 0, 0)
      keybd(vk, 0, KEYEVENTF_KEYUP, 0)
      if (winModifier) keybd(VK_LWIN, 0, KEYEVENTF_KEYUP, 0)
    },
  }
}
