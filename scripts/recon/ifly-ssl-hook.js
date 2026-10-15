// ifly-ssl-hook.js v3 — TLS 明文 + WS 客户端帧解掩码 + HMAC 密钥钓取
// 输出全走 send()。目标：iFlyPlatform.exe（libssl 4/4 已证）
'use strict'

function out(tag, text) {
  try { send({ tag: tag, text: String(text) }) } catch (e) { /* noop */ }
}

function findModule(re) {
  for (const m of Process.enumerateModules()) {
    if (re.test(m.name)) return m
  }
  return null
}

function enc(bytes) {
  const arr = new Uint8Array(bytes)
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ')
}

function ascii(bytes, cap) {
  const arr = new Uint8Array(bytes)
  const n = Math.min(arr.length, cap || 2048)
  let s = ''
  for (let i = 0; i < n; i++) {
    const b = arr[i]
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : b >= 0x80 ? '·' : '?'
  }
  if (arr.length > n) s += ` …(+${arr.length - n}B)`
  return s
}

// ── WS 帧解析（客户端侧带掩码） ──

function parseWSFrame(buf, len) {
  if (len < 2) return null
  const b0 = buf.readU8(0)
  const b1 = buf.readU8(1)
  if ((b0 & 0x80) === 0) return null // 非 FIN 首帧
  const opcode = b0 & 0x0f
  const masked = !!(b1 & 0x80)
  let plen = b1 & 0x7f
  let off = 2
  if (plen === 126) {
    if (len < 4) return null
    plen = buf.add(2).readU16()
    off = 4
  } else if (plen === 127) {
    if (len < 10) return null
    plen = buf.add(6).readU32() // 高 4 字节按 0 处理
    off = 10
  }
  if (off + (masked ? 4 : 0) + plen > len) return null
  const key = masked ? new Uint8Array(buf.add(off).readByteArray(4)) : null
  if (masked) off += 4
  const raw = new Uint8Array(buf.add(off).readByteArray(Math.min(plen, 65536)))
  if (key) {
    for (let i = 0; i < raw.length; i++) raw[i] ^= key[i % 4]
  }
  return { opcode, payload: raw, plen, consumed: off + plen }
}

function dumpWire(dir, buf, len) {
  if (len <= 0 || len > 1 << 20) return
  try {
    // 全量 hex 吐给离线解析器（无损源数据，帧拼接/重同步在 Node 侧完成）
    if (len <= 4096) {
      out(dir === '>>>' ? 'c-hex' : 's-hex', `${len}B ${enc(new Uint8Array(buf.readByteArray(len)))}`)
    }
    // HTTP 明文（握手请求/响应）直出
    const first = buf.readU8(0)
    const looksHttp = first === 0x47 || first === 0x48 // 'G'ET / 'H'TTP
    if (looksHttp) {
      out(dir, `${len}B [HTTP]\n${ascii(buf.readByteArray(Math.min(len, 4096)), 4096)}`)
      return
    }
    // 缓冲内可能粘连多个 WS 帧——逐个遍历解出
    let off = 0
    let frames = 0
    let textOut = ''
    while (off < len && frames < 12) {
      const frame = parseWSFrame(buf.add(off), len - off)
      if (!frame) break
      frames++
      const kind = frame.opcode === 1 ? 'TEXT' : frame.opcode === 2 ? 'BIN' : `OP${frame.opcode}`
      if (frame.opcode === 1) {
        textOut += `\n--- [WS ${kind} len=${frame.plen}] ---\n${ascii(frame.payload.buffer, 2048)}`
      } else {
        textOut += `\n--- [WS ${kind} len=${frame.plen}] hex(head64)=${enc(frame.payload.slice(0, 64))} ---\n${ascii(frame.payload.buffer, 256)}`
      }
      off += frame.consumed
    }
    if (frames > 0) {
      out(dir, `${len}B 共解出 ${frames} 帧，残余 ${len - off}B${textOut}`)
      if (len - off > 4) {
        // 残余（不完整尾帧）摘要
        out(dir + '~', `残余 ${len - off}B hex(head32)=${enc(new Uint8Array(buf.add(off).readByteArray(Math.min(len - off, 32))))}`)
      }
      return
    }
    out(dir, `${len}B [RAW]\n${ascii(buf.readByteArray(Math.min(len, 2048)), 2048)}`)
  } catch { /* noop */ }
}

// ── SSL 钩子 ──

const SSL_FUNCS = ['SSL_write', 'SSL_write_ex', 'SSL_read', 'SSL_read_ex']

function hookSSL() {
  const mod = findModule(/^libssl/i)
  if (!mod) return false
  let hooked = 0
  for (const name of SSL_FUNCS) {
    const addr = mod.findExportByName(name)
    if (!addr) continue
    Interceptor.attach(addr, {
      onEnter(args) {
        this.isWrite = name.startsWith('SSL_write')
        this.buf = args[1]
        this.len = args[2].toInt32()
      },
      onLeave(retval) {
        try {
          if (this.isWrite) {
            if (this.len > 0) dumpWire('>>>', this.buf, this.len)
          } else {
            const n = retval.toInt32()
            if (n > 0) dumpWire('<<<', this.buf, n)
          }
        } catch { /* noop */ }
      },
    })
    hooked++
  }
  out('hook', `${mod.name}: hooked ${hooked}/${SSL_FUNCS.length}`)
  return hooked > 0
}

// ── libcrypto HMAC 钩子（钓签名密钥与签名串） ──

function hookHMAC() {
  const crypto = findModule(/^libcrypto/i)
  if (!crypto) return false
  let n = 0

  // 一次性 API：unsigned char *HMAC(const EVP_MD *md, const void *key, int key_len,
  //                                 const unsigned char *d, size_t n, unsigned char *md_out, unsigned int *md_len)
  const oneShot = crypto.findExportByName('HMAC')
  if (oneShot) {
    Interceptor.attach(oneShot, {
      onEnter(args) {
        try {
          const keyLen = args[2].toInt32()
          const dataLen = args[4].toInt32()
          if (keyLen > 0 && keyLen < 256) {
            const key = args[1].readByteArray(keyLen)
            out('hmac-key', `[HMAC one-shot] len=${keyLen}\nhex: ${enc(key)}\nascii: ${ascii(key, 256)}`)
          }
          if (dataLen > 0 && dataLen < 4096) {
            out('hmac-data', `[${dataLen}B]\n${ascii(args[3].readByteArray(dataLen), 1024)}`)
          }
        } catch { /* noop */ }
      },
    })
    n++
  }

  // void HMAC_Init_ex(HMAC_CTX *ctx, const void *key, int key_len, const EVP_MD *md, ENGINE *impl)
  const initEx = crypto.findExportByName('HMAC_Init_ex')
  if (initEx) {
    Interceptor.attach(initEx, {
      onEnter(args) {
        try {
          const keyLen = args[2].toInt32()
          if (keyLen > 0 && keyLen < 256) {
            const key = args[1].readByteArray(keyLen)
            out('hmac-key', `[Init_ex] len=${keyLen}\nhex: ${enc(key)}\nascii: ${ascii(key, 256)}`)
          }
        } catch { /* noop */ }
      },
    })
    n++
  }

  // int HMAC_Update(HMAC_CTX *ctx, const unsigned char *data, size_t len)
  const update = crypto.findExportByName('HMAC_Update')
  if (update) {
    Interceptor.attach(update, {
      onEnter(args) {
        try {
          const len = args[2].toInt32()
          if (len > 0 && len < 4096) {
            out('hmac-data', `[Update ${len}B]\n${ascii(args[1].readByteArray(len), 1024)}`)
          }
        } catch { /* noop */ }
      },
    })
    n++
  }

  out('hook', `${crypto.name}: hooked ${n} hmac funcs`)
  return n > 0
}

// ── 内存扫描：api_key 现场 → 邻近的 secret 候选 ──

const API_KEY_ASCII = '15461402826c8360ebcf1270cbba88e5'

function scanForKey() {
  const needle = []
  for (let i = 0; i < API_KEY_ASCII.length; i++) needle.push(API_KEY_ASCII.charCodeAt(i))
  const pattern = needle.map((b) => b.toString(16).padStart(2, '0')).join(' ')
  let found = 0
  const ranges = Process.enumerateRanges('r--')
  for (const range of ranges) {
    if (range.size > 256 * 1024 * 1024) continue
    if (found >= 3) break
    try {
      Memory.scanSync(range.base, range.size, pattern).forEach((m) => {
        if (found >= 3) return
        found++
        const ctxBase = m.address.sub(192)
        let hex = ''
        let asc = ''
        try {
          const ctx = new Uint8Array(ctxBase.readByteArray(384))
          hex = Array.from(ctx).map((b) => b.toString(16).padStart(2, '0')).join(' ')
          asc = Array.from(ctx).map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
        } catch { hex = '(ctx unreadable)' }
        out('mem-key', `hit @ ${m.address} (base-192)\nhex: ${hex}\nascii: ${asc}`)
      })
    } catch { /* range unreadable */ }
  }
  if (!found) out('mem-key', '本轮未命中（api_key 可能尚未载入）')
  return found
}

// ── EVP_MAC（OpenSSL 3 新签名 API） ──

function hookEvpMac() {
  const crypto = findModule(/^libcrypto/i)
  if (!crypto) return false
  let n = 0
  // int EVP_MAC_init(EVP_MAC_CTX *ctx, const unsigned char *key, size_t keylen, const OSSL_PARAM params[])
  const init = crypto.findExportByName('EVP_MAC_init')
  if (init) {
    Interceptor.attach(init, {
      onEnter(args) {
        try {
          const keyLen = args[2].toInt32()
          if (keyLen > 0 && keyLen < 256) {
            const key = args[1].readByteArray(keyLen)
            out('hmac-key', `[EVP_MAC_init] len=${keyLen}\nhex: ${enc(key)}\nascii: ${ascii(key, 256)}`)
          }
        } catch { /* noop */ }
      },
    })
    n++
  }
  // EVP_Q_mac(libctx, name, propq, digest, props, key, keylen, data, datalen, out, outsize, outlen)
  const qmac = crypto.findExportByName('EVP_Q_mac')
  if (qmac) {
    Interceptor.attach(qmac, {
      onEnter(args) {
        try {
          const keyLen = args[6].toInt32()
          const dataLen = args[8].toInt32()
          if (keyLen > 0 && keyLen < 256) {
            const key = args[5].readByteArray(keyLen)
            out('hmac-key', `[EVP_Q_mac] len=${keyLen}\nhex: ${enc(key)}\nascii: ${ascii(key, 256)}`)
          }
          if (dataLen > 0 && dataLen < 4096) {
            out('hmac-data', `[Q_mac ${dataLen}B]\n${ascii(args[7].readByteArray(dataLen), 1024)}`)
          }
        } catch { /* noop */ }
      },
    })
    n++
  }
  if (n) out('hook', `${crypto.name}: hooked ${n} evp-mac funcs`)
  return n > 0
}

out('boot', `script loaded; tls modules: ${Process.enumerateModules().map((m) => m.name).filter((x) => /ssl|crypto|schannel|ncrypt|winhttp|wininet|xfnet|fly/i.test(x)).join(', ')}`)

let sslOk = hookSSL()
let hmacOk = hookHMAC()
let macOk = hookEvpMac()

// api_key 现场扫描：载入时 + 每 20s 重扫（配置可能惰性载入）
scanForKey()
const scanTimer = setInterval(scanForKey, 20000)

// 惰性加载的模块在载入瞬间同步挂钩（零竞态窗口）——轮询有漏拍风险
Process.attachModuleObserver({
  onAdded(module) {
    if (!sslOk && /^libssl/i.test(module.name)) sslOk = hookSSL()
    if (!hmacOk && /^libcrypto/i.test(module.name)) hmacOk = hookHMAC()
    if (!macOk && /^libcrypto/i.test(module.name)) macOk = hookEvpMac()
  },
})

if (!sslOk || !hmacOk || !macOk) {
  const timer = setInterval(() => {
    if (!sslOk) sslOk = hookSSL()
    if (!hmacOk) hmacOk = hookHMAC()
    if (!macOk) macOk = hookEvpMac()
    if (sslOk && hmacOk && macOk) clearInterval(timer)
  }, 500)
}
