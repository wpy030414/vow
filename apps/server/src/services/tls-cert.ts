// tls-cert.ts — 自签名 TLS 证书生成与缓存
//
// 首次运行时用 openssl 生成自签名证书，SAN 包含所有 LAN IP，
// 之后缓存到 vowDir（repo 根 .vow/，gitignored）。移动端浏览器以 HTTPS 访问 LAN IP
// 时满足安全上下文要求，getUserMedia() 正常工作。
//
// vowDir 由调用方注入（index.ts 以 pnpm-workspace.yaml 为锚定位 repo 根）——
// 修复此前固定上溯 4 层在打包产物（apps/server/dist）下会漂移到仓库外的问题。

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces, hostname } from 'node:os'

export interface TLSCert {
  key: Buffer
  cert: Buffer
}

/**
 * 定位 openssl 可执行文件。
 *
 * Windows 不自带 openssl——它通常只存在于 Git for Windows 的 `usr\bin` / `mingw64\bin`，
 * 而这些目录只有当进程从 Git Bash 启动时才会进 PATH。从 PowerShell / cmd / IDE 启动的
 * dev server 因此找不到 openssl，execSync 会以 `status: 1` + 空 stdout/stderr 失败
 * （cmd.exe 在 exec 层就报错，什么都吐不出来），现象极具误导性。
 *
 * 策略：先按 PATH 试，失败则回退到常见安装位置，全都没有就抛出可读错误。
 */
function resolveOpenssl(): string {
  try {
    execSync('openssl version', { stdio: 'pipe', windowsHide: true, timeout: 5000 })
    return 'openssl'
  } catch {
    // PATH 上没有，继续探测常见安装位置
  }

  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\usr\\bin\\openssl.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\Git\\mingw64\\bin\\openssl.exe`,
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL\\bin\\openssl.exe',
    '/usr/bin/openssl',
    '/usr/local/bin/openssl',
    '/opt/homebrew/bin/openssl',
  ].filter((p) => !p.startsWith('\\') && p.length > 0)

  const hit = candidates.find((p) => existsSync(p))
  if (hit) {
    console.log(`[TLS] openssl 不在 PATH 上，回退到: ${hit}`)
    return `"${hit}"`
  }

  throw new Error(
    '[TLS] 未找到 openssl。请安装 Git for Windows（自带 openssl），' +
      '或把 openssl 所在目录加入 PATH 后重试。',
  )
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

/** 用 openssl 生成自签名证书（写入 vowDir） */
function generate(vowDir: string): { keyPem: string; certPem: string } {
  const keyPath = join(vowDir, 'key.pem')
  const certPath = join(vowDir, 'cert.pem')
  if (!existsSync(vowDir)) mkdirSync(vowDir, { recursive: true })

  const sans = getSANs()
  console.log('[TLS] SANs:', sans.join(' | '))

  const isWin = process.platform === 'win32'
  // 路径引用（处理空格和特殊字符）
  const quote = (p: string) => (isWin ? `"${p}"` : `'${p}'`)
  const keyQ = quote(keyPath)
  const certQ = quote(certPath)
  const sanExt = sans.map((s) => s).join(',')
  const openssl = resolveOpenssl()

  // 注意：不重定向 openssl 的 stderr。它被吞掉时，失败只会表现为
  // `status: 1` + 空输出，无从诊断；这里统一由 runOpenssl 附加到错误信息上。
  const runOpenssl = (args: string) => {
    try {
      execSync(`${openssl} ${args}`, { timeout: 10000, stdio: 'pipe', windowsHide: true })
    } catch (err) {
      const stderr = String((err as { stderr?: Buffer }).stderr ?? '').trim()
      throw new Error(`[TLS] openssl 执行失败: ${openssl} ${args}${stderr ? `\n${stderr}` : ''}`)
    }
  }

  // 生成私钥
  runOpenssl(`genrsa -out ${keyQ} 2048`)

  // 生成自签名证书（有效期 10 年，serverAuth + CA:FALSE）
  runOpenssl(
    `req -x509 -new -key ${keyQ} -out ${certQ} -days 3650 -subj "/CN=vow/O=vow" ` +
      `-addext "subjectAltName=${sanExt}" ` +
      `-addext "extendedKeyUsage=serverAuth" ` +
      `-addext "basicConstraints=critical,CA:FALSE" ` +
      `-addext "keyUsage=digitalSignature,keyEncipherment" -nodes`,
  )

  const keyPem = readFileSync(keyPath, 'utf-8')
  const certPem = readFileSync(certPath, 'utf-8')
  return { keyPem, certPem }
}

// ─── 公开 API ───

/** 确保证书存在（首次自动生成），返回 key + cert PEM Buffer */
export function ensureCert(vowDir: string): TLSCert {
  const keyPath = join(vowDir, 'key.pem')
  const certPath = join(vowDir, 'cert.pem')
  if (existsSync(keyPath) && existsSync(certPath)) {
    console.log('[TLS] using cached certificate (.vow/)')
    return {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    }
  }

  console.log('[TLS] generating self-signed certificate...')
  const { keyPem, certPem } = generate(vowDir)

  return {
    key: Buffer.from(keyPem, 'utf-8'),
    cert: Buffer.from(certPem, 'utf-8'),
  }
}

/** 证书文件路径（供 Vite 等外部消费） */
export function certPaths(vowDir: string) {
  ensureCert(vowDir)
  return { key: join(vowDir, 'key.pem'), cert: join(vowDir, 'cert.pem') }
}
