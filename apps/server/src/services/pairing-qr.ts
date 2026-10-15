// pairing-qr.ts — 终端配对二维码打印
//
// qrcode-terminal 经 createRequire 动态加载（无类型依赖注入点，复用 adm-zip 惯例）；
// 库缺失时降级为纯链接文本，不影响配对功能本身。

import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'

const req = createRequire(import.meta.url)

interface QrTerminalModule {
  generate: (text: string, opts: { small: boolean }, cb: (qrcode: string) => void) => void
}

/** 本机全部非回环 IPv4（局域网可达地址） */
export function listLanIPv4(): string[] {
  const out: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address)
    }
  }
  return out
}

/** 物理网卡优先：192.168/10 段排前，172.16-31（WSL/Hyper-V 虚拟网卡）排后——手机连虚拟网卡必失败 */
function lanScore(ip: string): number {
  if (ip.startsWith('192.168.')) return 0
  if (ip.startsWith('10.')) return 1
  return 2
}

/** 打印配对二维码 + 链接（第一条可达地址出二维码，其余列备用地址） */
export function printPairingCode(port: number, token: string, log: (line: string) => void = console.log): void {
  const ips = listLanIPv4().sort((a, b) => lanScore(a) - lanScore(b))
  const target = ips[0] ?? '127.0.0.1'
  const url = `https://${target}:${port}/?t=${token}`

  log('')
  log('[Auth] 配对二维码——手机扫码即可连接（令牌持久于 .vow/pairing-token；轮换: pnpm pair --rotate）')
  try {
    const qr = req('qrcode-terminal') as QrTerminalModule
    qr.generate(url, { small: true }, (code) => log(code))
  } catch {
    log('  (qrcode-terminal 不可用——请直接打开下方链接)')
  }
  log(`  配对链接：${url}`)
  for (const ip of ips.slice(1)) {
    log(`  备用地址：https://${ip}:${port}/?t=${token}`)
  }
  log('')
}
