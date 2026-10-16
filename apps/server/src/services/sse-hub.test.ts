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

describe('SSEHub 流生命周期（断连解绑而非销毁）', () => {
  it('getOrCreateStream 对未知 id 按【原 id】复活，不生成随机 id', () => {
    const hub = new SSEHub()
    const sid = 'vow-client-provided-id'
    const { session } = hub.getOrCreateStream(sid)
    expect(session.id).toBe(sid)
    expect(hub.getSession(sid)).toBe(session)
    expect(hub.getConnectionInfo().sessions).toEqual([sid])
  })

  it('onSessionInit 同时覆盖新建与复活路径（接线不漏）', () => {
    const hub = new SSEHub()
    const inited: string[] = []
    hub.onSessionInit = (s) => inited.push(s.id)
    const created = hub.createSession()
    hub.getOrCreateStream('vow-resumed-id')
    expect(inited).toEqual([created.id, 'vow-resumed-id'])
  })

  it('detachStream 解绑 writer 但保留会话；再取流复用同一会话', () => {
    const hub = new SSEHub()
    const s = hub.createSession()
    hub.getOrCreateStream(s.id)
    const w1 = s.writer
    expect(w1).not.toBeNull()

    hub.detachStream(s.id, w1)
    expect(s.writer).toBeNull() // 不再接收心跳/输出广播
    expect(hub.getSession(s.id)).toBe(s) // 会话未被销毁

    hub.getOrCreateStream(s.id) // EventSource 自动重连
    expect(s.writer).not.toBeNull()
    expect(hub.getSession(s.id)).toBe(s) // 仍是同一会话（未重建、无刷屏日志）
  })

  it('迟到的旧连接 close（writer 已被新连接替换）不误清新 writer', () => {
    const hub = new SSEHub()
    const s = hub.createSession()
    hub.getOrCreateStream(s.id)
    const stale = s.writer
    hub.getOrCreateStream(s.id) // 新连接先于旧 close 接管
    const current = s.writer
    expect(current).not.toBe(stale)

    hub.detachStream(s.id, stale) // 旧连接的 close 迟到
    expect(s.writer).toBe(current) // 不受影响
  })
})
