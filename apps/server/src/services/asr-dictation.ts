// asr-dictation — 听写引擎抽象（DECISIONS A21）
//
// 只定义「引擎」接口，不含任何具体实现：
//   - 内置实现：services/iflytek-asr.ts（讯飞私有 ASR 直连，默认且当前唯一）
//   - 其余渠道：将来在此接口上实现并在 createDictationEngine 中登记即可
//
// Win+H 系统听写已移除（识别质量过低，且只在特定宿主环境成立，不具备通用价值）。

/**
 * 听写引擎标识。
 * 新增渠道时在此联合类型追加成员，并在 {@link createDictationEngine} 中登记。
 */
export type DictationEngineId = 'iflytek-api'

/** 一次听写会话的生命周期——由引擎实现自行管理连接与推流 */
export interface DictationEngine {
  /** 开始一次会话（重复调用应先丢弃旧会话） */
  start(): void
  /** 推入一块 base64 PCM 音频 */
  feed(base64Pcm: string, sampleRate: number): void
  /** 结束会话：等待最终文本，经 hooks 交付 */
  stop(): Promise<void>
  /** 立即中止（不经交付） */
  cancel(): void
  isActive(): boolean
}

/** 引擎工厂依赖的宿主能力：把最终文本送到宿主（当前为键盘注入） */
export interface DictationEngineHooks {
  /** 最终文本——打字注入在此完成 */
  onFinalText: (text: string) => void | Promise<void>
}

/** 引擎工厂：给定配置与 hooks 构造一个引擎实例 */
export type DictationEngineFactory = (hooks: DictationEngineHooks) => DictationEngine

/** 已登记的引擎实现（将来新增渠道只需往这里加一项） */
export type DictationEngineRegistry = Partial<Record<DictationEngineId, DictationEngineFactory>>

/**
 * 按 id 构造引擎。
 * 未登记的实现直接抛错——配置与代码不一致属于编程错误，不应静默降级。
 */
export function createDictationEngine(
  id: DictationEngineId,
  hooks: DictationEngineHooks,
  registry: DictationEngineRegistry,
): DictationEngine {
  const factory = registry[id]
  if (!factory) throw new Error(`[ASR] 未登记的听写引擎：${id}`)
  return factory(hooks)
}
