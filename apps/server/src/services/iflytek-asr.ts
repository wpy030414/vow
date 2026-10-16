// iflytek-asr — 讯飞私有 ASR 直连（协议见 scripts/recon/FINDINGS.md，已回放验证）
//
// 链路：签名握手 → WS 推流 raw PCM16@16k（业务参数内联首帧）→ 逐字结果 → status:2 收尾
// 音频容器（实况端点接受 raw 直发，无需 opus）：data.audio = base64(PCM16LE)

import crypto from 'node:crypto'
import WebSocket, { type RawData } from 'ws'

export const IFLYTEK_HOST = '100ime-iat-api.xfyun.cn'
export const IFLYTEK_PATH = '/v2/iat'

// ─── 配置 ───

export interface AsrConfig {
  apiKey: string
  apiSecret: string
  appId: string
}

// 内置凭据——base64(JSON) 直接集成于源码：开箱即用，默认引擎 iflytek-api 零配置可用。
// 来源：对本机已安装讯飞客户端的互操作分析（scripts/recon/FINDINGS.md）；
// 设备级凭据，仅供本机个人使用。env 逐字段覆盖（VOW_IFLYTEK_API_KEY / _API_SECRET / _APP_ID）。
const BUILTIN_CREDENTIALS_B64 =
  'eyJhcGlLZXkiOiIxNTQ2MTQwMjgyNmM4MzYwZWJjZjEyNzBjYmJhODhlNSIsImFwaVNlY3JldCI6InNIOHYyd1NTeHhIVHkxVU5mTjZkRmFTcVZqbG1SN0JCIiwiYXBwSWQiOiIxMDBJTUUifQ=='

const BUILTIN: AsrConfig = (() => {
  const parsed = JSON.parse(Buffer.from(BUILTIN_CREDENTIALS_B64, 'base64').toString('utf8')) as Partial<AsrConfig>
  if (!parsed.apiKey || !parsed.apiSecret) throw new Error('内置讯飞凭据解码失败（BUILTIN_CREDENTIALS_B64 损坏）')
  return { apiKey: parsed.apiKey, apiSecret: parsed.apiSecret, appId: parsed.appId || '100IME' }
})()

/** 生效配置 = 内置凭据 ⊕ env 逐字段覆盖（永远可用，不再有「凭据缺失」分支） */
export function resolveAsrConfig(env: NodeJS.ProcessEnv = process.env): AsrConfig {
  return {
    apiKey: env.VOW_IFLYTEK_API_KEY || BUILTIN.apiKey,
    apiSecret: env.VOW_IFLYTEK_API_SECRET || BUILTIN.apiSecret,
    appId: env.VOW_IFLYTEK_APP_ID || BUILTIN.appId,
  }
}

// ─── 签名（算法经真实会话签名精确复现验证）───

export function buildSignedUrl(cfg: AsrConfig, date: string = new Date().toUTCString()): string {
  const signStr = `host: ${IFLYTEK_HOST}\ndate: ${date}\nGET ${IFLYTEK_PATH} HTTP/1.1`
  const sig = crypto.createHmac('sha256', cfg.apiSecret).update(signStr).digest('base64')
  const auth = `hmac username="${cfg.apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return (
    `wss://${IFLYTEK_HOST}${IFLYTEK_PATH}` +
    `?date=${encodeURIComponent(date)}&host=${IFLYTEK_HOST}` +
    `&authorization=${encodeURIComponent(Buffer.from(auth).toString('base64'))}`
  )
}

// ─── 音频转换 ───

/** base64 PCM16LE → Float32（[-1,1)） */
export function base64ToFloat32(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64')
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** Float32 → base64 PCM16LE */
export function float32ToPcm16Base64(samples: Float32Array): string {
  const buf = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), i * 2)
  }
  return buf.toString('base64')
}

/** 线性插值重采样到 16000Hz（与 virtual-audio 的 resample 同法） */
export function resampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === 16000 || input.length === 0) return input
  const ratio = inRate / 16000
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const t = src - i0
    out[i] = input[i0] * (1 - t) + input[i1] * t
  }
  return out
}

/** 80ms @16k —— 实况客户端节奏（每 JSON 块约 2×40ms opus 包） */
export const FRAME_SAMPLES = 1280

export interface Framer {
  /** 喂入样本，吐出凑满的整帧 */
  push(samples: Float32Array): Float32Array[]
  /** 取出残余（不足一帧的尾段；无残余返回 null） */
  flush(): Float32Array | null
}

export function createFramer(): Framer {
  let pending = new Float32Array(0)
  return {
    push(samples) {
      if (samples.length === 0) return []
      const merged = new Float32Array(pending.length + samples.length)
      merged.set(pending, 0)
      merged.set(samples, pending.length)
      const frames: Float32Array[] = []
      let off = 0
      while (merged.length - off >= FRAME_SAMPLES) {
        frames.push(merged.slice(off, off + FRAME_SAMPLES))
        off += FRAME_SAMPLES
      }
      pending = merged.slice(off)
      return frames
    },
    flush() {
      if (pending.length === 0) return null
      const last = pending
      pending = new Float32Array(0)
      return last
    },
  }
}

// ─── 会话 ───

export interface AsrSessionEvents {
  onError?: (err: Error) => void
}

export interface AsrSession {
  /** 喂入 vow 的 PCM（base64 PCM16 + 采样率），内部重采样/分帧/发送 */
  feedPcm(base64Pcm: string, sampleRate: number): void
  /** 收尾：尾帧 status:2 → 等最终结果（超时以 interim 兜底）→ 返回全文 */
  finish(timeoutMs?: number): Promise<string>
  abort(): void
  isClosed(): boolean
}

export interface CreateAsrSessionOptions extends AsrSessionEvents {
  /** 测试注入 ws 工厂 */
  wsFactory?: (url: string) => WebSocket
}

interface WsMessage {
  code?: number
  message?: string
  data?: {
    status?: number
    result?: { ls?: boolean; ws?: Array<{ cw?: Array<{ w?: string }> }> }
  }
}

/** device_id 样式复刻实况（base64 随机 16B），进程内复用 */
const DEVICE_ID = `vow${Buffer.from(crypto.randomBytes(12)).toString('base64').replace(/[+/=]/g, '').slice(0, 18)}v`
let uidCounter = 0

function makeUid(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  return `${stamp}${String(d.getMilliseconds()).padStart(3, '0')}${++uidCounter}`
}

export function createAsrSession(cfg: AsrConfig, opts: CreateAsrSessionOptions = {}): AsrSession {
  const factory = opts.wsFactory ?? ((url: string) => new WebSocket(url, {
    headers: {
      Origin: `https://${IFLYTEK_HOST}`,
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      // 服务端不回显子协议（不依赖协商，手动发头；ws 包严格协商会报错）
      'Sec-WebSocket-Protocol': 'dumb-increment-protocol',
    },
  }))

  const framer = createFramer()
  const ws = factory(buildSignedUrl(cfg))
  let interim = ''
  let finished = false
  let firstFrameSent = false
  let resolveFinish: ((text: string) => void) | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  const business = {
    aue: 'raw',
    ent: 'sms16k',
    eos: 4000,
    vad_enable: true,
    vad_speech_tail: 4000,
    vad_timeout: 4000,
  }

  function frameJson(samples: Float32Array, status: 1 | 2): string {
    const data = {
      audio: float32ToPcm16Base64(samples),
      encoding: 'raw',
      format: 'audio/L16;rate=16000',
      status,
    }
    if (!firstFrameSent) {
      firstFrameSent = true
      return JSON.stringify({
        business,
        common: {
          app_id: cfg.appId,
          'app.ver': 'vow-0.1',
          device_id: DEVICE_ID,
          'device.imei': DEVICE_ID,
          'device.imsi': DEVICE_ID,
          uid: makeUid(),
        },
        data,
      })
    }
    return JSON.stringify({ data })
  }

  function send(samples: Float32Array, status: 1 | 2) {
    if (finished) return
    try {
      if (ws.readyState === WebSocket.OPEN) {
        // 背压保护：积压超过 512KB 时丢帧（宁可丢音频不要爆内存）
        if (ws.bufferedAmount > 512 * 1024) return
        ws.send(frameJson(samples, status))
      }
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  ws.on('message', (raw: RawData) => {
    let msg: WsMessage
    try {
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      msg = JSON.parse(buf.toString())
    } catch {
      return
    }
    if (msg.code !== 0) {
      opts.onError?.(new Error(`[ASR] 服务端错误 code=${msg.code} ${msg.message ?? ''}`))
      return
    }
    const words = msg.data?.result?.ws ?? []
    const piece = words.map((w) => (w.cw ?? []).map((c) => c.w ?? '').join('')).join('')
    if (piece) {
      interim += piece
    }
    if (msg.data?.result?.ls || msg.data?.status === 2) {
      finished = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolveFinish?.(interim)
      resolveFinish = null
      try { ws.close() } catch { /* noop */ }
    }
  })

  ws.on('error', (err: Error) => {
    opts.onError?.(err)
    if (!finished) {
      finished = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolveFinish?.(interim)
      resolveFinish = null
    }
  })

  return {
    feedPcm(base64Pcm, sampleRate) {
      if (finished || ws.readyState !== WebSocket.OPEN) return
      const samples = resampleTo16k(base64ToFloat32(base64Pcm), sampleRate)
      for (const frame of framer.push(samples)) send(frame, 1)
    },

    finish(timeoutMs = 6000) {
      if (finished) return Promise.resolve(interim)
      const residual = framer.flush()
      // 尾帧必须带音频（实况如此）；全程无音频时发一小段静音兜底
      send(residual ?? new Float32Array(160), 2)
      return new Promise<string>((resolve) => {
        resolveFinish = resolve
        timeoutTimer = setTimeout(() => {
          if (!finished) {
            finished = true
            resolve(interim)
            try { ws.close() } catch { /* noop */ }
          }
        }, timeoutMs)
      })
    },

    abort() {
      finished = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      resolveFinish?.(interim)
      resolveFinish = null
      try { ws.close() } catch { /* noop */ }
    },

    isClosed: () => finished,
  }
}

// ─── 听写门面（供 index.ts 接线）───

export interface AsrDictationHooks {
  /** 最终文本——打字注入在此完成 */
  onFinalText: (text: string) => void | Promise<void>
}

export interface AsrDictation {
  start(): void
  feed(base64Pcm: string, sampleRate: number): void
  /** 松手收尾：等最终文本并触发 onFinalText */
  stop(): Promise<void>
  cancel(): void
  isActive(): boolean
}

export function createAsrDictation(
  cfg: AsrConfig,
  hooks: AsrDictationHooks,
  createSession: typeof createAsrSession = createAsrSession,
): AsrDictation {
  let session: AsrSession | null = null

  return {
    start() {
      session?.abort()
      session = createSession(cfg, {
        onError: (err) => console.warn('[ASR]', err.message),
      })
      console.log('[ASR] 会话开始')
    },

    feed(base64Pcm, sampleRate) {
      session?.feedPcm(base64Pcm, sampleRate)
    },

    async stop() {
      const s = session
      if (!s) return
      session = null
      const text = await s.finish()
      console.log(`[ASR] 会话结束：${text || '(空)'}`)
      if (text) await hooks.onFinalText(text)
    },

    cancel() {
      session?.abort()
      session = null
    },

    isActive: () => session !== null,
  }
}
