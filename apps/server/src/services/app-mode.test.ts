// app-mode.test.ts — qwennote-eva 形态硬约束的策略单测

import { describe, it, expect } from 'vitest'
import { createModePolicy } from './app-mode'

describe('qwennote-eva 硬约束', () => {
  const policy = createModePolicy('qwennote-eva')

  it('会话录制模式恒 tap——客户端请求 hold 也被压回', () => {
    expect(policy.connectMode('hold')).toBe('tap')
    expect(policy.connectMode('tap')).toBe('tap')
    expect(policy.connectMode(undefined)).toBe('tap')
  })

  it('状态整形：mode / isOutputEnabled 压制，dictation 对齐录音态', () => {
    const coerced = policy.coerceStateUpdate(
      { recording: true, mode: 'hold', isOutputEnabled: true, dictation: false },
      false,
    )
    expect(coerced).toMatchObject({ mode: 'tap', isOutputEnabled: false, dictation: true })
  })

  it('停录翻转：dictation 随 recording 归 false（ASR 收尾触发器）', () => {
    const coerced = policy.coerceStateUpdate({ recording: false, dictation: true }, true)
    expect(coerced.dictation).toBe(false)
  })

  it('上报未携带 recording 时沿用会话当前录音态', () => {
    expect(policy.coerceStateUpdate({ audioLevel: 0.5 }, true).dictation).toBe(true)
    expect(policy.coerceStateUpdate({ audioLevel: 0.5 }, false).dictation).toBe(false)
  })

  it('整形保留未涉字段（audioLevel 等透传）', () => {
    expect(policy.coerceStateUpdate({ recording: true, audioLevel: 0.7 }, false).audioLevel).toBe(
      0.7,
    )
  })

  it('耳返（输出捕获）恒拒绝', () => {
    expect(policy.outputEnabledAllowed()).toBe(false)
  })
})

describe('codex-micro 全透传', () => {
  const policy = createModePolicy('codex-micro')

  it('connectMode：请求值透传，缺省 tap', () => {
    expect(policy.connectMode('hold')).toBe('hold')
    expect(policy.connectMode(undefined)).toBe('tap')
  })

  it('状态上报与耳返均不整形', () => {
    const update = {
      recording: true,
      mode: 'hold' as const,
      isOutputEnabled: true,
      dictation: false,
    }
    expect(policy.coerceStateUpdate(update, false)).toBe(update)
    expect(policy.outputEnabledAllowed()).toBe(true)
  })
})
