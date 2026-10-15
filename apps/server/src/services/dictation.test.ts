import { describe, it, expect } from 'vitest'
import { createDictation, resolveEngineConfig, type NativeKeys } from './dictation'

function fakeKeys() {
  const calls: string[] = []
  const keys: NativeKeys = {
    supported: true,
    chord: (win, vk) => calls.push(`${win ? 'win+' : ''}${vk.toString(16)}`),
  }
  return { keys, calls }
}

const WIN_CFG = resolveEngineConfig({} as NodeJS.ProcessEnv)

describe('createDictation — toggle 引擎（Win+H）', () => {
  it('状态翻转才注入，重复同值去重', async () => {
    const { keys, calls } = fakeKeys()
    const svc = createDictation(keys, WIN_CFG)
    await svc.setDesired(true, 't')
    await svc.setDesired(true, 't') // 重复，不注入
    await svc.setDesired(false, 't')
    expect(calls).toEqual(['win+48', 'win+48'])
  })

  it('并发请求经串行队列保序', async () => {
    const { keys, calls } = fakeKeys()
    const svc = createDictation(keys, WIN_CFG)
    await Promise.all([svc.setDesired(true, 'a'), svc.setDesired(false, 'b')])
    expect(calls).toHaveLength(2)
  })

  it('releaseNow 同步停止；已关闭时不再注入', async () => {
    const { keys, calls } = fakeKeys()
    const svc = createDictation(keys, WIN_CFG)
    await svc.setDesired(true, 't')
    svc.releaseNow('shutdown')
    svc.releaseNow('again') // 幂等
    expect(calls).toHaveLength(2)
  })
})

describe('平台降级', () => {
  it('注入不可用时静默忽略且不抛错', async () => {
    const keys: NativeKeys = {
      supported: false,
      chord: () => { throw new Error('should not fire') },
    }
    const svc = createDictation(keys, WIN_CFG)
    await expect(svc.setDesired(true, 't')).resolves.toBeUndefined()
    expect(svc.isSupported()).toBe(false)
  })
})
