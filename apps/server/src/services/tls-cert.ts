// tls-cert.ts — 自签名 TLS 证书生成与缓存
//
// 首次运行时用 openssl 生成自签名证书，SAN 包含所有 LAN IP，
// 之后缓存到 .vow/ 目录。移动端浏览器以 HTTPS 访问 LAN IP
// 时满足安全上下文要求，getUserMedia() 正常工作。

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces, hostname } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const CERT_DIR = join(repoRoot, '.vow')
const KEY_PATH = join(CERT_DIR, 'key.pem')
const CERT_PATH = join(CERT_DIR, 'cert.pem')

export interface TLSCert {
  key: Buffer
  cert: Buffer
}

/** 收集本机所有 LAN IPv4 地址 + localhost */
function getSANs(): string[] {
  const entries: string[] = ['DNS:localhost', 'IP:127.0.0.1', `DNS:${hostname()}`]
  const nics = networkInterfaces()
  for (const [, addrs] of Object.entries(nics)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        entries.push(`IP:${addr.address}`)
      }
    }
  }
  return entries
}

/** 用 openssl 生成自签名证书 */
function generate(): { keyPem: string; certPem: string } {
  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true })

  const sans = getSANs()
  const subjectAltName = sans.join(',')
  console.log('[TLS] SANs:', sans.join(' | '))

  const isWin = process.platform === 'win32'
  const nullDev = isWin ? 'NUL' : '/dev/null'
  // PowerShell 风格的路径引用（处理空格和特殊字符）
  const quote = (p: string) => isWin ? `"${p}"` : `'${p}'`
  const keyQ = quote(KEY_PATH)
  const certQ = quote(CERT_PATH)
  const sanExt = sans.map((s) => s).join(',')

  // 生成私钥
  const genrsaCmd = isWin
    ? `openssl genrsa -out ${keyQ} 2048 2>${nullDev}`
    : `openssl genrsa -out ${keyQ} 2048 2>/dev/null`
  execSync(genrsaCmd, { timeout: 10000, stdio: 'pipe', windowsHide: true })

  // 生成自签名证书（有效期 10 年，serverAuth + CA:FALSE）
  const reqCmd = isWin
    ? `openssl req -x509 -new -key ${keyQ} -out ${certQ} -days 3650 -subj "/CN=vow/O=vow" -addext "subjectAltName=${sanExt}" -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=digitalSignature,keyEncipherment" -nodes 2>${nullDev}`
    : `openssl req -x509 -new -key ${keyQ} -out ${certQ} -days 3650 -subj "/CN=vow/O=vow" -addext "subjectAltName=${sanExt}" -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=digitalSignature,keyEncipherment" -nodes 2>/dev/null`
  execSync(reqCmd, { timeout: 10000, stdio: 'pipe', windowsHide: true })

  const keyPem = readFileSync(KEY_PATH, 'utf-8')
  const certPem = readFileSync(CERT_PATH, 'utf-8')
  return { keyPem, certPem }
}

// ─── 公开 API ───

/** 确保证书存在（首次自动生成），返回 key + cert PEM Buffer */
export function ensureCert(): TLSCert {
  if (existsSync(KEY_PATH) && existsSync(CERT_PATH)) {
    console.log('[TLS] using cached certificate (.vow/)')
    return {
      key: readFileSync(KEY_PATH),
      cert: readFileSync(CERT_PATH),
    }
  }

  console.log('[TLS] generating self-signed certificate...')
  const { keyPem, certPem } = generate()

  return {
    key: Buffer.from(keyPem, 'utf-8'),
    cert: Buffer.from(certPem, 'utf-8'),
  }
}

/** 证书文件路径（供 Vite 等外部消费） */
export function certPaths() {
  ensureCert()
  return { key: KEY_PATH, cert: CERT_PATH }
}