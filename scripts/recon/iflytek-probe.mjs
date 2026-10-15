// iflytek-probe.mjs — 自建客户端回放验证
// 用自己的签名握手 + 重放 attach-more5.log 里捕获的真实音频块，验证协议实现正确
import crypto from 'node:crypto'
import fs from 'node:fs'
import WebSocket from 'ws'

const API_KEY = process.env.VOW_IFLYTEK_API_KEY || '15461402826c8360ebcf1270cbba88e5'
const API_SECRET = process.env.VOW_IFLYTEK_API_SECRET || 'sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB'
const HOST = '100ime-iat-api.xfyun.cn'
const PATH = '/v2/iat'

// ─── 从捕获日志提取客户端 JSON 帧（首帧含 business/common，尾帧 status:2）───

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

// ─── 签名与握手 ───

function buildUrl() {
  const date = new Date().toUTCString()
  const signStr = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`
  const sig = crypto.createHmac('sha256', API_SECRET).update(signStr).digest('base64')
  const auth = `hmac username="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${sig}"`
  return `wss://${HOST}${PATH}?date=${encodeURIComponent(date)}&host=${HOST}&authorization=${encodeURIComponent(Buffer.from(auth).toString('base64'))}`
}

// ─── 主流程 ───

const captured = extractCapturedFrames('scripts/recon/attach-more5.log')
console.log(`[probe] 捕获帧数: ${captured.length}（首帧业务参数 app_id=${captured[0].common?.app_id}）`)

let finalText = ''

const url = buildUrl()
console.log('[probe] 握手 URL 已签名，连接中…')

// 忠实复刻捕获到的握手头（Origin 等，Kong 可能校验）。
// 注意：服务端不回显 Sec-WebSocket-Protocol → 不能走 ws 的子协议协商（会报
// "Server sent no subprotocol"），改为手动发头、由服务端忽略。
const ws = new WebSocket(url, {
  headers: {
    Origin: `https://${HOST}`,
    Pragma: 'no-cache',
    'Cache-Control': 'no-cache',
    'Sec-WebSocket-Protocol': 'dumb-increment-protocol',
  },
})

ws.on('unexpected-response', (_req, res) => {
  console.error(`[probe] 握手被拒: HTTP ${res.statusCode}`)
  console.error('[probe] 响应头:', JSON.stringify(res.headers))
  let body = ''
  res.on('data', (d) => { body += d })
  res.on('end', () => {
    console.error('[probe] 响应体:', body.slice(0, 500))
    process.exit(1)
  })
})

ws.on('open', async () => {
  console.log('[probe] WS 已建立，开始回放音频…')
  for (let i = 0; i < captured.length; i++) {
    ws.send(JSON.stringify(captured[i]))
    if (i % 20 === 0) console.log(`[probe] 已发送 ${i + 1}/${captured.length}`)
    await new Promise((r) => setTimeout(r, 25))
  }
  console.log('[probe] 全部发送完毕（含 status:2 结束帧），等待结果…')
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())
  console.log(`[server] ${JSON.stringify(msg).slice(0, 400)}`)
  const words = msg.data?.result?.ws ?? []
  finalText += words.map((w) => w.cw?.map((c) => c.w).join('') ?? '').join('')
  if (msg.data?.result?.ls || msg.data?.status === 2) {
    console.log('\n===== 最终转写 =====')
    console.log(finalText || '(空)')
    console.log('====================')
    ws.close()
    process.exit(0)
  }
})

ws.on('error', (err) => {
  console.error('[probe] WS 错误:', err.message || err, err.code ?? '')
  process.exit(1)
})

ws.on('close', (e) => {
  console.log(`[probe] 连接关闭 code=${e}`)
  process.exit(0)
})

setTimeout(() => {
  console.error('[probe] 超时（20s）')
  process.exit(1)
}, 20000)
