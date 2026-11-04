// win32-keys — 原生注入底层（koffi → user32）
// 辅助键（backspace / enter）与 Unicode 文本注入，均走 SendInput。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ─── Win32 常量 ───

export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const VK_BACK = 0x08
export const VK_RETURN = 0x0d
const INPUT_KEYBOARD = 1

// ─── koffi / user32 加载（进程内缓存）───

interface User32Handles {
  // koffi 无官方类型，使用结构化 any
  user32: { func: (sig: string) => unknown }
}

let user32Cache: User32Handles | null | undefined

function loadUser32(): User32Handles | null {
  if (user32Cache !== undefined) return user32Cache
  if (process.platform !== 'win32') {
    user32Cache = null
    return null
  }
  try {
    // koffi 预编译二进制随包分发，此处 createRequire 保证打包后仍从 server 依赖解析
    const koffi = require('koffi') as { load: (dll: string) => User32Handles['user32'] }
    user32Cache = { user32: koffi.load('user32.dll') }
  } catch (err) {
    console.warn('[win32-keys] user32 加载失败：', err instanceof Error ? err.message : err)
    user32Cache = null
  }
  return user32Cache
}

// ─── Unicode 文本注入（SendInput）───
// 注意：keybd_event 的 bScan 是 BYTE（8 位），无法承载 UTF-16 码元
// （中文会被截断成低字节乱码）；Unicode 注入必须走 SendInput（KEYBDINPUT.wScan: WORD）

export type SendUnicodeFn = (unit: number) => void

let cachedSender: SendUnicodeFn | null | undefined
let warnedSendFailure = false

export function loadUnicodeSender(): SendUnicodeFn | null {
  if (cachedSender !== undefined) return cachedSender
  const u = loadUser32()
  if (!u) {
    cachedSender = null
    return null
  }
  try {
    const koffi = require('koffi') as {
      struct: (name: string, fields: Record<string, unknown>) => unknown
      union: (name: string, fields: Record<string, unknown>) => unknown
      sizeof: (type: unknown) => number
    }
    const KEYBDINPUT = koffi.struct('VOW_KEYBDINPUT', {
      wVk: 'uint16',
      wScan: 'uint16',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    })
    const MOUSEINPUT = koffi.struct('VOW_MOUSEINPUT', {
      dx: 'int32',
      dy: 'int32',
      mouseData: 'uint32',
      dwFlags: 'uint32',
      time: 'uint32',
      dwExtraInfo: 'uintptr_t',
    })
    const INPUT_UNION = koffi.union('VOW_INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT })
    const INPUT = koffi.struct('VOW_INPUT', { type: 'uint32', u: INPUT_UNION })
    const cbSize = koffi.sizeof(INPUT)
    const sendInput = u.user32.func(
      'uint32 __stdcall SendInput(uint32 cInputs, VOW_INPUT *pInputs, int cbSize)',
    ) as (count: number, inputs: unknown[], size: number) => number

    cachedSender = (unit: number) => {
      const make = (flags: number) => ({
        type: INPUT_KEYBOARD,
        u: { ki: { wVk: 0, wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
      })
      const injected = sendInput(
        2,
        [make(KEYEVENTF_UNICODE), make(KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)],
        cbSize,
      )
      if (injected !== 2 && !warnedSendFailure) {
        warnedSendFailure = true
        console.warn(
          `[win32-keys] SendInput 注入失败（返回 ${injected}/2）——目标窗口是否以管理员运行（UIPI 拦截）？`,
        )
      }
    }
  } catch (err) {
    console.warn('[win32-keys] SendInput 绑定失败：', err instanceof Error ? err.message : err)
    cachedSender = null
  }
  return cachedSender
}
