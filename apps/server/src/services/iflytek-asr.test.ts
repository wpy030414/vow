import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  buildSignedUrl,
  resampleTo16k,
  createFramer,
  float32ToPcm16Base64,
  base64ToFloat32,
  createAsrSession,
  FRAME_SAMPLES,
  type AsrConfig,
} from './iflytek-asr'

const CFG: AsrConfig = {
  apiKey: '15461402826c8360ebcf1270cbba88e5',
  apiSecret: 'sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB',
  appId: '100IME',
}

describe('签名 URL', () => {
  it('复现真实会话签名（2026-10-15 15:28:44 实况 golden 向量）', () => {
    const date = 'Thu, 15 Oct 2026 15:28:44 GMT'
    const url = buildSignedUrl(CFG, date)
    const httpsUrl = url.replace('wss://', 'https://')
    const authB64 = new URL(httpsUrl).searchParams.get('authorization')!
    const auth = Buffer.from(decodeURIComponent(authB64), 'base64').toString()
    expect(auth).toContain('username="15461402826c8360ebcf1270cbba88e5"')
    expect(auth).toContain('algorithm="hmac-sha256"')
    expect(auth).toContain('headers="host date request-line"')
    expect(auth).toContain('signature="/WlV8Lvm9L9qGw4rn//WpVlYschhJD5IWVPN2lRNP7M="')
  })
})

describe('音频转换', () => {
  it('resampleTo16k：44100 → 16000 长度与常量保持', () => {
    const input = new Float32Array(44100).fill(0.5)
    const out = resampleTo16k(input, 44100)
    expect(out.length).toBe(16000)
    expect(out[123]).toBeCloseTo(0.5, 5)
  })

  it('resampleTo16k：已是 16000 时原样返回', () => {
    const input = new Float32Array(8).fill(0.1)
    expect(resampleTo16k(input, 16000)).toBe(input)
  })

  it('float32 → PCM16LE base64 → float32 往返', () => {
    const b64 = float32ToPcm16Base64(new Float32Array([0, 1, -1]))
    expect(b64).toBe('AAD/fwGA')
    const back = base64ToFloat32(b64)
    expect(back[0]).toBe(0)
    expect(back[1]).toBeCloseTo(1, 4)
    expect(back[2]).toBeCloseTo(-1, 4)
  })

  it('createFramer：整帧切分与残余 flush', () => {
    const framer = createFramer()
    const frames = framer.push(new Float32Array(FRAME_SAMPLES * 2 + 440))
    expect(frames).toHaveLength(2)
    frames.forEach((f) => expect(f.length).toBe(FRAME_SAMPLES))
    const residual = framer.flush()
    expect(residual?.length).toBe(440)
    expect(framer.flush()).toBeNull()
  })
})

// ─── 会话（假 ws）───

class FakeWs extends EventEmitter {
  readyState = 1 // WebSocket.OPEN
  bufferedAmount = 0
  sent: string[] = []
  send(s: string) {
    this.sent.push(s)
  }
  close() {
    this.emit('close')
  }
}

describe('createAsrSession', () => {
  it('首帧内联 business/common（raw），尾帧 status:2，收尾返回全量文本', async () => {
    const fake = new FakeWs()
    const session = createAsrSession(CFG, {
      wsFactory: () => fake as never,
    })

    // feed 2560 样本（80ms×2 @16k）
    const pcm = new Float32Array(FRAME_SAMPLES * 2).fill(0.01)
    session.feedPcm(float32ToPcm16Base64(pcm), 16000)
    expect(fake.sent).toHaveLength(2)

    const first = JSON.parse(fake.sent[0])
    expect(first.business.aue).toBe('raw')
    expect(first.common.app_id).toBe('100IME')
    expect(first.data.encoding).toBe('raw')
    expect(first.data.format).toBe('audio/L16;rate=16000')
    expect(first.data.status).toBe(1)
    const second = JSON.parse(fake.sent[1])
    expect(second.business).toBeUndefined()
    expect(second.data.status).toBe(1)

    // 服务端流式 + 终帧
    fake.emit('message', Buffer.from(JSON.stringify({ code: 0, data: { status: 0, result: { ls: false, ws: [{ cw: [{ w: '你好' }] }] } } })))
    fake.emit('message', Buffer.from(JSON.stringify({ code: 0, data: { status: 0, result: { ls: false, ws: [{ cw: [{ w: '世界' }] }] } } })))

    const finished = session.finish(2000)
    const tail = JSON.parse(fake.sent[fake.sent.length - 1])
    expect(tail.data.status).toBe(2)

    fake.emit('message', Buffer.from(JSON.stringify({ code: 0, data: { status: 2, result: { ls: true, ws: [{ cw: [{ w: '！' }] }] } } })))
    await expect(finished).resolves.toBe('你好世界！')
    expect(session.isClosed()).toBe(true)
  })

  it('超时以 interim 兜底', async () => {
    const fake = new FakeWs()
    const session = createAsrSession(CFG, { wsFactory: () => fake as never })
    fake.emit('message', Buffer.from(JSON.stringify({ code: 0, data: { status: 0, result: { ls: false, ws: [{ cw: [{ w: '半句' }] }] } } })))
    await expect(session.finish(80)).resolves.toBe('半句')
  })

  it('服务端错误码上报 onError', () => {
    const fake = new FakeWs()
    const errors: string[] = []
    createAsrSession(CFG, { wsFactory: () => fake as never, onError: (e) => errors.push(e.message) })
    fake.emit('message', Buffer.from(JSON.stringify({ code: 10163, message: 'invalid audio' })))
    expect(errors[0]).toContain('10163')
  })
})
