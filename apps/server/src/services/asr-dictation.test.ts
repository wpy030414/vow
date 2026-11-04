// asr-dictation.test.ts — 听写引擎抽象：注册表派发与契约

import { describe, it, expect } from 'vitest'
import { createDictationEngine, type DictationEngine } from './asr-dictation'

function stubEngine(): DictationEngine & {
  starts: number
  feeds: Array<[string, number]>
  stops: number
  cancels: number
} {
  const e = {
    starts: 0,
    feeds: [] as Array<[string, number]>,
    stops: 0,
    cancels: 0,
    start() {
      e.starts += 1
    },
    feed(b64: string, rate: number) {
      e.feeds.push([b64, rate])
    },
    async stop() {
      e.stops += 1
    },
    cancel() {
      e.cancels += 1
    },
    isActive: () => e.starts > e.stops + e.cancels,
  }
  return e
}

describe('createDictationEngine', () => {
  it('按 id 从未登记的实现构造——未登记时直接抛错，不静默降级', () => {
    expect(() => createDictationEngine('iflytek-api', { onFinalText: () => {} }, {})).toThrow(
      /未登记的听写引擎/,
    )
  })

  it('派发到注册的工厂并透传 hooks', () => {
    const engine = stubEngine()
    let received: ((t: string) => void | Promise<void>) | null = null
    const built = createDictationEngine(
      'iflytek-api',
      {
        onFinalText: () => {},
      },
      {
        'iflytek-api': (hooks) => {
          received = hooks.onFinalText
          return engine
        },
      },
    )
    expect(built).toBe(engine)
    expect(received).toBeTypeOf('function')
  })

  it('契约：start / feed / stop / cancel 生命周期可组合', async () => {
    const engine = stubEngine()
    const built = createDictationEngine(
      'iflytek-api',
      { onFinalText: () => {} },
      {
        'iflytek-api': () => engine,
      },
    )

    built.start()
    built.feed('QUJD', 16000)
    expect(engine.starts).toBe(1)
    expect(engine.feeds).toEqual([['QUJD', 16000]])
    expect(built.isActive()).toBe(true)

    await built.stop()
    expect(engine.stops).toBe(1)
    expect(built.isActive()).toBe(false)

    built.cancel()
    expect(engine.cancels).toBe(1)
  })
})
