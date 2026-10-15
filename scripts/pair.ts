// scripts/pair.ts — 打印配对二维码 / 轮换配对令牌
//
// 用法：
//   pnpm pair                  打印配对二维码（默认端口 48085 = 生产形态）
//   pnpm pair --port 48086     dev 模式（手机连 Vite）
//   pnpm pair --rotate         生成新令牌——所有已配对设备立即失效（怀疑令牌泄漏时的补救）

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadOrCreateToken } from '../apps/server/src/services/auth'
import { printPairingCode } from '../apps/server/src/services/pairing-qr'

const args = process.argv.slice(2)
const portArg = args.indexOf('--port')
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.PORT || 48085)
const rotate = args.includes('--rotate')

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vowDir = resolve(repoRoot, '.vow')

const token = loadOrCreateToken(vowDir, { rotate })
if (rotate) console.log('[Auth] 令牌已轮换——所有已配对设备需要重新扫码')
printPairingCode(port, token)
