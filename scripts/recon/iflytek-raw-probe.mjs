// iflytek-raw-probe.mjs — 实验：服务端是否接受 encoding=raw（PCM16 直发）
// 路径：捕获的 opus 音频 → opusscript 解码 → PCM16 → 以 raw 重新分帧回放
// 若转写与实况一致 → 引擎免 Opus 编码依赖；若报错 → 走 opusscript 编码路线
import crypto from 'node:crypto'
import fs from 'node:fs'
import WebSocket from 'ws'
import OpusScript from 'opusscript'

const API_KEY = process.env.VOW_IFLYTEK_API_KEY || '15461402826c8360ebcf1270cbba88e5'
const API_SECRET = process.env.VOW_IFLYTEK_API_SECRET || 'sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB'
const HOST = '100ime-iat-api.xfyun.cn'
const PATH_NAME = '/v2/iat'

// ─── 提取捕获帧（同 iflytek-probe）───

function extractCapturedFrames(logPath) {
  const log = fs.readFileSync(logPath, 'utf8')
  const chunks = []
  for (const line of log.split('\n')) {
    const m = line.match(/\[c-hex\] (\d+)B ((?:[0-9a-f]{2} )*[0-9a-f]{2})\s*$/)
    if (m) chunks.push(Buffer.from(m[2].replace(/ /g, ''), 'hex'))
  }
  const all = Buffer.concat(chunks)
  const idx = all.lastIndexOf('GET /v2/iat')
  let pos = all.indexOf('\r\n\r\n', idx) + 4
  const frames = []
  while (pos + 2 <= all.length) {
    const b1 = all[pos + 1]
    const masked = !!(b1 & 0x80)
    let plen = b1 & 0x7f
    let off = pos + 2
    if (plen === 126) { plen = all.readUInt16BE(off); off += 2 } else if (plen === 127) { plen = Number(all.readBigUInt64BE(off)); off += 8 }
    let key = null
    if (masked) { key = all.subarray(off, off + 4); off += 4 }
    if (off + plen > all.length) break
    const payload = Buffer.from(all.subarray(off, off + plen))
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]
    frames.push(JSON.parse(payload.toString('utf8')))
    pos = off + plen
  }
  return frames
}

function buildUrl() {
  const date = new Date().toUTCString()
  const signStr = `host: ${HOST}\ndate: ${date}\nGET ${PATH_NAME} HTTP/1.1`
  const sig = crypto.createHmac('sha256', API_SECRET).update(signStr).digest('base64')
  const auth = `hmac username="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return `wss://${HOST}${PATH_NAME}?date=${encodeURIComponent(date)}&host=${HOST}&authorization=${encodeURIComponent(Buffer.from(auth).toString('base64'))}`
}

// ─── opus → PCM16 解码 ───

function toInt16(x) {
  if (x instanceof Int16Array) return x
  if (x instanceof Uint8Array) return new Int16Array(x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength))
  if (x instanceof ArrayBuffer) return new Int16Array(x)
  throw new Error(`未知解码返回类型: ${x?.constructor?.name}`)
}

const captured = extractCapturedFrames('scripts/recon/attach-more5.log')
const business = captured[0].business
const common = captured[0].common
console.log(`[exp] 捕获 ${captured.length} 帧；business=${JSON.stringify(business)}`)

const decoder = new OpusScript(16000, 1)

// 音频容器结构（已实证）：[2B BE 长度][opus 包] 循环；每包 40ms @16k（640 样本）
function decodeChunk(b64) {
  const buf = Buffer.from(b64, 'base64')
  const pcmParts = []
  let off = 0
  while (off + 2 <= buf.length) {
    const len = buf.readUInt16BE(off)
    off += 2
    if (len === 0 || off + len > buf.length) break
    pcmParts.push(toInt16(decoder.decode(buf.subarray(off, off + len))))
    off += len
  }
  return pcmParts
}

let pcmTotal = 0
const pcmParts = []
for (const f of captured) {
  const b64 = f.data?.audio
  if (!b64) continue
  for (const p of decodeChunk(b64)) {
    pcmParts.push(p)
    pcmTotal += p.length
  }
}
console.log(`[exp] opus 解码完成：${pcmTotal} 样本 (${(pcmTotal / 16000).toFixed(1)}s @16k)`)

// 拼接 PCM → 60ms 一段（960 样本）重新分帧
const merged = new Int16Array(pcmTotal)
let w = 0
for (const p of pcmParts) { merged.set(p, w); w += p.length }

const FRAME_SAMPLES = 960
const rawFrames = []
for (let i = 0; i < merged.length; i += FRAME_SAMPLES) {
  const seg = merged.subarray(i, Math.min(i + FRAME_SAMPLES, merged.length))
  rawFrames.push(Buffer.from(seg.buffer, seg.byteOffset, seg.byteLength).toString('base64'))
}
console.log(`[exp] 重分帧 ${rawFrames.length} 帧（raw PCM16）`)

function rawFrame(i) {
  const data = { audio: rawFrames[i], encoding: 'raw', format: 'audio/L16;rate=16000', status: i === rawFrames.length - 1 ? 2 : 1 }
  if (i === 0) {
    return { business: { ...business, aue: 'raw' }, common, data }
  }
  return { data }
}

// ─── 连接与回放 ───

let finalText = ''
const ws = new WebSocket(buildUrl(), {
  headers: {
    Origin: `https://${HOST}`,
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Sec-WebSocket-Protocol': 'dumb-increment-protocol',
  },
})

ws.on('unexpected-response', (_req, res) => {
  console.error(`[exp] 握手被拒: HTTP ${res.statusCode}`)
  let body = ''
  res.on('data', (d) => { body += d })
  res.on('end', () => { console.error(body.slice(0, 500)); process.exit(1) })
})

ws.on('open', async () => {
  console.log('[exp] WS 已建立，以 raw 回放…')
  for (let i = 0; i < rawFrames.length; i++) {
    ws.send(JSON.stringify(rawFrame(i)))
    await new Promise((r) => setTimeout(r, 25))
  }
  console.log('[exp] 发送完毕')
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  if (msg.code !== 0) {
    console.error(`[exp] 服务端错误: ${JSON.stringify(msg).slice(0, 400)}`)
  } else {
    console.log(`[server] ${JSON.stringify(msg).slice(0, 200)}`)
  }
  const words = msg.data?.result?.ws ?? []
  finalText += words.map((w) => w.cw?.map((c) => c.w).join('') ?? '').join('')
  if (msg.data?.result?.ls || msg.data?.status === 2) {
    console.log('\n===== raw 通道最终转写 =====')
    console.log(finalText || '(空)')
    console.log('============================')
    process.exit(0)
  }
})

ws.on('error', (err) => {
  console.error('[exp] WS 错误:', err.message || err)
  process.exit(1)
})

setTimeout(() => { console.error('[exp] 超时'); process.exit(1) }, 25000)
