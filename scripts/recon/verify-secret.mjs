// verify-secret.mjs — 用捕获到的两次真实会话签名，验证内存里钓出的 secret
import crypto from 'node:crypto'

const secret = 'sH8v2wSSxxHTy1UNfN6dFaSqVjlmR7BB'
const host = '100ime-iat-api.xfyun.cn'

const cases = [
  { date: 'Thu, 15 Oct 2026 15:35:06 GMT', sig: 'rru0w70wGdKibvO0TXxYTsz95qRO53nKXstOievTxAA0=' },
  { date: 'Thu, 15 Oct 2026 15:28:44 GMT', sig: '/WlV8Lvm9L9qGw4rn//WpVlYschhJD5IWVPN2lRNP7M=' },
]

// 签名串构造的几个变体（xfyun 文档 + 观测到的 query 变形）
const builders = [
  ['无尾换行', (d) => `host: ${host}\ndate: ${d}\nGET /v2/iat HTTP/1.1`],
  ['带尾换行', (d) => `host: ${host}\ndate: ${d}\nGET /v2/iat HTTP/1.1\n`],
  ['request-line 带 query', (d) => `host: ${host}\ndate: ${d}\nGET /v2/iat?date=${encodeURIComponent(d)}&host=${host} HTTP/1.1`],
]

let matched = false
for (const c of cases) {
  for (const [name, build] of builders) {
    const s = build(c.date)
    const out = crypto.createHmac('sha256', secret).update(s).digest('base64')
    const ok = out === c.sig
    if (ok) matched = true
    console.log(`[${c.date}] ${name}: ${ok ? '✅ 匹配！' : '✗'} -> ${out}`)
  }
}
console.log(matched ? '\n=== 密钥验证通过：签名可复现 ===' : '\n=== 未匹配：secret 候选不对 ===')
