// dictation — 语音转文字联动：hold 按下时唤起宿主机听写引擎
//
// 引擎路线（DECISIONS A11）：
//   iflytek-api     讯飞私有 ASR 直连（services/iflytek-asr.ts）——默认引擎（凭据内置，开箱即用），
//                   由 index.ts 直接路由，本服务的构建器仅保留 win 实现
//   win-dictation   Win+H 系统听写（toggle：松开时再注入一次关闭）——注入
//                   VOW_DICTATION_ENGINE=win-dictation 才启用

import { loadNativeKeys, VK_H, type NativeKeys } from './win32-keys'

export type { NativeKeys } from './win32-keys'

// ─── 引擎 ───

export type DictationEngineId = 'win-dictation' | 'iflytek-api'

export interface EngineRuntime {
  /** 开始听写 */
  start: () => void
  /** 结束听写；null = 引擎自行结束（如服务端 ASR 会话随音频流收尾） */
  stop: (() => void) | null
}

export interface EngineConfig {
  engine: DictationEngineId
}

export function resolveEngineConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  // 默认 iflytek-api（开箱即用）；想用 Win+H 系统听写才需注入 env
  return { engine: env.VOW_DICTATION_ENGINE === 'win-dictation' ? 'win-dictation' : 'iflytek-api' }
}

export function buildEngine(keys: NativeKeys): EngineRuntime {
  const winH = () => keys.chord(true, VK_H)
  return { start: winH, stop: winH }
}

// ─── 服务 ───

export interface DictationService {
  isSupported(): boolean
  engineId(): DictationEngineId
  /**
   * 请求听写开/关。
   * toggle 引擎（win-dictation）按期望态翻转去重；自动结束引擎每次 start 都触发。
   * iflytek-api 引擎不经过本服务（index.ts 直接路由到 ASR 门面）。
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
  const engine = buildEngine(keys)
  let active = false // 我们认为听写当前是否开启
  let queue: Promise<void> = Promise.resolve()
  let warnedUnsupported = false

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
