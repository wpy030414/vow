// dictation — 语音转文字联动：hold 按下时唤起宿主机听写引擎
//
// 引擎路线（DECISIONS A11，仅两条）：
//   win-dictation   Win+H 系统听写（toggle：松开时再注入一次关闭）——现役保底
//   iflytek-api     讯飞私有 ASR 协议直连（服务端 PCM → 文本 → SendInput 打字）——演进中
//
// 注入走串行队列 + 最小间隔，防止快速连按时按键序列被并发打散。

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ─── Win32 常量 ───

const KEYEVENTF_KEYUP = 0x0002
const VK_LWIN = 0x5b
const VK_H = 0x48

// ─── 原生按键注入 ───

type KeybdEventFn = (bVk: number, bScan: number, dwFlags: number, dwExtraInfo: number) => void

function loadKeybdEvent(): KeybdEventFn | null {
  if (process.platform !== 'win32') return null
  try {
    // koffi 预编译二进制随包分发，此处 createRequire 保证 tsup 打包后仍从 server 依赖解析
    const koffi = require('koffi') as {
      load: (dll: string) => { func: (sig: string) => KeybdEventFn }
    }
    const user32 = koffi.load('user32.dll')
    return user32.func(
      'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)',
    )
  } catch (err) {
    console.warn('[Dictation] 原生按键注入不可用：', err instanceof Error ? err.message : err)
    return null
  }
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

// ─── 引擎 ───

export type DictationEngineId = 'win-dictation' | 'iflytek-api'

export interface EngineRuntime {
  /** 开始听写 */
  start: () => void
  /** 结束听写；null = 引擎自行结束（如服务端 ASR 会话随音频流结束而关闭） */
  stop: (() => void) | null
}

export interface EngineConfig {
  engine: DictationEngineId
}

export function resolveEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  return { engine: env.VOW_DICTATION_ENGINE === 'iflytek-api' ? 'iflytek-api' : 'win-dictation' }
}

export function buildEngine(cfg: EngineConfig, keys: NativeKeys): EngineRuntime {
  // iflytek-api 引擎落地前回落到 win-dictation（createDictation 会告警一次）
  const winH = () => keys.chord(true, VK_H)
  return { start: winH, stop: winH }
}

// ─── 服务 ───

export interface DictationService {
  isSupported(): boolean
  engineId(): DictationEngineId
  /**
   * 请求听写开/关。
   * toggle 引擎（win-dictation）按期望态翻转去重；
   * 自动结束引擎（stop === null）每次 start 都触发（引擎可能已自行结束，不能去重）。
   */
  setDesired(desired: boolean, reason: string): Promise<void>
  /** 同步强制关闭——进程退出路径用，不等队列 */
  releaseNow(reason: string): void
}

/** 两次注入之间的最小间隔，防止快速连按时 OS 端合成错乱 */
const CHORD_INTERVAL_MS = 40

export function createDictation(
  keys: NativeKeys = loadNativeKeys(),
  cfg: EngineConfig = resolveEngineConfig(),
): DictationService {
  const engine = buildEngine(cfg, keys)
  let active = false // 我们认为听写当前是否开启（自动结束引擎恒为 false）
  let queue: Promise<void> = Promise.resolve()
  let warnedUnsupported = false
  let warnedFallback = cfg.engine === 'iflytek-api'

  if (cfg.engine === 'iflytek-api') {
    console.warn('[Dictation] iflytek-api 引擎尚未实现，回落 win-dictation')
  }

  const fire = (label: string, reason: string, inject: () => void) => {
    queue = queue
      .then(async () => {
        if (!keys.supported) {
          if (!warnedUnsupported) {
            warnedUnsupported = true
            console.warn('[Dictation] 引擎不可用（非 win32 或 user32 加载失败），忽略所有注入请求')
          }
          return
        }
        try {
          inject()
          console.log(`[Dictation] ${label} (${reason})`)
        } catch (err) {
          console.warn(`[Dictation] ${label} 注入失败:`, err instanceof Error ? err.message : err)
        }
        await new Promise((r) => setTimeout(r, CHORD_INTERVAL_MS))
      })
      .catch(() => {})
  }

  return {
    isSupported: () => keys.supported,
    engineId: () => cfg.engine,
    setDesired(desired, reason) {
      if (engine.stop === null) {
        if (desired) fire('start', reason, engine.start)
        return queue
      }
      if (desired === active) return queue
      active = desired
      fire(desired ? 'start' : 'stop', reason, desired ? engine.start : engine.stop!)
      return queue
    },
    releaseNow(reason) {
      if (engine.stop === null || !active) return
      active = false
      try {
        engine.stop()!
        console.log(`[Dictation] stop (${reason}, sync)`)
      } catch { /* 尽力而为 */ }
    },
  }
}

/** 全局单例 */
export const dictation = createDictation()
