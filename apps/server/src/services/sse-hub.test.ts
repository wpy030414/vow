import { describe, it, expect } from 'vitest'
import { SSEHub } from './sse-hub'

function makeHub() {
  const hub = new SSEHub()
  const events: Array<[boolean, string, string]> = []
  hub.onDictationChange = (active, sessionId, reason) => events.push([active, sessionId, reason])
  return { hub, events }
}

describe('SSEHub 听写联动', () => {
  it('会话初始 dictation=false', () => {
    const { hub } = makeHub()
    const s = hub.createSession(undefined, 'hold')
    expect(s.state.dictation).toBe(false)
  })

  it('状态翻转触发 toggle 回调，重复上报同值不触发', () => {
    const { hub, events } = makeHub()
    const s = hub.createSession(undefined, 'hold')
    hub.updateState(s.id, { dictation: true })
    hub.updateState(s.id, { dictation: true })
    hub.updateState(s.id, { dictation: false })
    expect(events).toEqual([
      [true, s.id, 'toggle'],
      [false, s.id, 'toggle'],
    ])
  })

  it('普通字段更新不触发听写回调', () => {
    const { hub, events } = makeHub()
    const s = hub.createSession(undefined, 'hold')
    hub.updateState(s.id, { recording: true, audioLevel: 0.5 })
    expect(events).toHaveLength(0)
  })

  it('会话销毁时若听写仍开着则强制释放', () => {
    const { hub, events } = makeHub()
    const s = hub.createSession(undefined, 'hold')
    hub.updateState(s.id, { dictation: true })
    hub.destroySession(s.id)
    expect(events.at(-1)).toEqual([false, s.id, 'release'])
    expect(hub.getSession(s.id)).toBeUndefined()
  })

  it('听写未开启时销毁不触发 release', () => {
    const { hub, events } = makeHub()
    const s = hub.createSession(undefined, 'hold')
    hub.destroySession(s.id)
    expect(events).toHaveLength(0)
  })
})
