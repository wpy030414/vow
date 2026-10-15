// parse-frames.mjs — 离线解析 attach-more5.log 里的全量 hex 流
// 客户端方向（c-hex，掩码帧）与服务端方向（s-hex）分别拼接为完整字节流后逐帧解码
import fs from 'node:fs'

const LOG = process.argv[2] || 'scripts/recon/attach-more5.log'
const log = fs.readFileSync(LOG, 'utf8')

const streams = { c: [], s: [] }
for (const line of log.split('\n')) {
  const m = line.match(/\[(c-hex|s-hex)\] (\d+)B ((?:[0-9a-f]{2} )*[0-9a-f]{2})\s*$/)
  if (m) streams[m[1][0]].push(Buffer.from(m[3].replace(/ /g, ''), 'hex'))
}
console.log(`hex 块: client ${streams.c.length} / server ${streams.s.length}`)

function parseFrames(dir) {
  const all = Buffer.concat(streams[dir])
  console.log(`\n===== ${dir === 'c' ? '客户端' : '服务端'}流 ${all.length}B =====`)

  // 定位最后一个 HTTP 请求/响应头之后的位置（取最后一条连接）
  let pos = 0
  if (dir === 'c') {
    const idx = all.lastIndexOf('GET /v2/iat')
    if (idx < 0) { console.log('未找到 GET 握手'); return }
    pos = all.indexOf('\r\n\r\n', idx)
    if (pos < 0) { console.log('HTTP 头未终结'); return }
    pos += 4
    console.log('--- HTTP 握手（尾部 500B）---')
    console.log(all.slice(Math.max(0, pos - 500), pos).toString('latin1').replace(/\r\n/g, '\n'))
  } else {
    const idx = all.lastIndexOf('HTTP/1.1')
    if (idx < 0) { console.log('未找到 HTTP 响应'); return }
    pos = all.indexOf('\r\n\r\n', idx)
    if (pos < 0) { console.log('HTTP 头未终结'); return }
    pos += 4
    console.log('--- HTTP 101（尾部 300B）---')
    console.log(all.slice(Math.max(0, pos - 300), pos).toString('latin1').replace(/\r\n/g, '\n'))
  }

  // 逐帧解析（无需重同步：流本身连续）
  let n = 0
  while (pos + 2 <= all.length) {
    const b0 = all[pos]
    const b1 = all[pos + 1]
    if ((b0 & 0x80) === 0) { console.log(`\n[!] 位置 ${pos} 帧头异常 b0=0x${b0.toString(16)}，停止`); break }
    const opcode = b0 & 0x0f
    const masked = !!(b1 & 0x80)
    let plen = b1 & 0x7f
    let off = pos + 2
    if (plen === 126) { plen = all.readUInt16BE(off); off += 2 } else if (plen === 127) { plen = Number(all.readBigUInt64BE(off)); off += 8 }
    let key = null
    if (masked) { key = all.subarray(off, off + 4); off += 4 }
    if (off + plen > all.length) { console.log(`\n[~] 尾部不完整帧: op=${opcode} len=${plen} 剩余=${all.length - off}`); break }
    let payload = Buffer.from(all.subarray(off, off + plen))
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]
    n++
    const kind = opcode === 1 ? 'TEXT' : opcode === 2 ? 'BIN' : `OP${opcode}`
    const tag = `${dir === 'c' ? '>>>' : '<<<'} #${n} ${kind} ${plen}B`
    const text = payload.toString('utf8')
    const isJson = text.startsWith('{')
    if (isJson) {
      console.log(`\n${tag}\n${text.slice(0, 3000)}${text.length > 3000 ? ' …' : ''}`)
    } else {
      console.log(`\n${tag} 非JSON: ${payload.subarray(0, 80).toString('latin1')}`)
    }
    pos = off + plen
  }
  console.log(`\n（${dir === 'c' ? '客户端' : '服务端'}共 ${n} 帧）`)
}

parseFrames('c')
parseFrames('s')
