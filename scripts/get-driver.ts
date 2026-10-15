// scripts/get-driver.ts — 下载并安装 VB-Cable 虚拟音频驱动
//
// 用法：pnpm get-driver（需管理员权限）
// 驱动包缓存于 vendor/VBCABLE/，重复运行跳过下载

import { createRequire } from 'node:module'
import { exec } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { pipeline } from 'node:stream/promises'

const req = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const VB_CABLE_DOWNLOAD_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
const VB_CABLE_KEYWORD = 'CABLE'
const VB_CABLE_SERVICE_NAME = 'VBAudioVACMME'
const INSTALL_DIR = join(repoRoot, 'vendor', 'VBCABLE')

// ─── 工具 ───

function log(msg: string) { console.log(`[get-driver] ${msg}`) }
function warn(msg: string) { console.warn(`[get-driver] ⚠ ${msg}`) }

function scanForCable(): boolean {
  // 方式 1：naudiodon 设备扫描（最可靠）
  try {
    const naudi = req('@gpeng/naudiodon') as { getDevices(): Array<{ id: number; name: string; maxInputChannels: number; maxOutputChannels: number }> }
    if (naudi.getDevices().some(
      (d) => d.name.toUpperCase().includes(VB_CABLE_KEYWORD) && d.maxOutputChannels > 0,
    )) return true
  } catch { /* 回退到服务检测 */ }

  // 方式 2：Windows 服务检测
  try {
    exec(`sc query ${VB_CABLE_SERVICE_NAME}`, { timeout: 3000 })
    // sc query 退出码 0 = 服务存在
    return true
  } catch { /* 不存在 */ }

  return false
}

async function download(dir: string): Promise<void> {
  const zipPath = join(dir, 'VBCABLE_Driver_Pack43.zip')
  if (existsSync(zipPath)) {
    log('ZIP already downloaded, extracting...')
    const AdmZip = req('adm-zip') as new (p: string) => { extractAllTo: (t: string, o: boolean) => void }
    new AdmZip(zipPath).extractAllTo(dir, true)
    return
  }

  log(`downloading from ${VB_CABLE_DOWNLOAD_URL} ...`)
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(zipPath)
    get(VB_CABLE_DOWNLOAD_URL, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          file.close()
          get(redirectUrl, (res2) => pipeline(res2, file).then(resolve).catch(reject)).on('error', reject)
          return
        }
      }
      if (response.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${response.statusCode}`)); return }
      pipeline(response, file).then(resolve).catch(reject)
    }).on('error', reject)
  })

  log('extracting...')
  const AdmZip = req('adm-zip') as new (p: string) => { extractAllTo: (t: string, o: boolean) => void }
  new AdmZip(zipPath).extractAllTo(dir, true)
  log('extracted')
}

function getInfPath(dir: string): string {
  const files = readdirSync(dir)
  const x64 = files.find((f) => f.toLowerCase().includes('x64') && f.endsWith('.inf'))
  if (x64) return join(dir, x64)
  const any = files.find((f) => f.endsWith('.inf'))
  if (any) return join(dir, any)
  throw new Error('未找到 .inf 驱动安装文件——请检查 vendor/VBCABLE/ 目录')
}

async function install(infPath: string): Promise<void> {
  const cmd = `pnputil /add-driver "${infPath}" /install`
  log(`running: ${cmd}`)
  return new Promise<void>((resolve, reject) => {
    exec(cmd, { timeout: 60_000 }, (err, stdout, stderr) => {
      const output = stdout + stderr
      if (err) {
        if (output.includes('successfully') || output.includes('established') || output.includes('0x0')) {
          log(output.trim()); resolve(); return
        }
        reject(err)
      } else {
        log(output.trim()); resolve()
      }
    })
  })
}

async function waitForDevice(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now()
  log('waiting for CABLE device to appear...')
  return new Promise<boolean>((resolve) => {
    const tick = () => {
      if (scanForCable()) { log('CABLE device detected!'); resolve(true); return }
      if (Date.now() - start > timeoutMs) { warn('timeout — CABLE device not found'); resolve(false); return }
      setTimeout(tick, 2000)
    }
    tick()
  })
}

// ─── 入口 ───

async function main() {
  // 1. 快速检查
  if (scanForCable()) {
    log('VB-Cable is already installed — nothing to do')
    return
  }

  // 2. 管理员检查
  const isElevated = (req('is-elevated') as { default: () => Promise<boolean> }).default
  if (!(await isElevated())) {
    warn('需要管理员权限才能安装音频驱动')
    warn('请以管理员身份运行: pnpm get-driver')
    process.exit(1)
  }

  // 3. 下载 + 解压
  if (!existsSync(INSTALL_DIR)) mkdirSync(INSTALL_DIR, { recursive: true })
  await download(INSTALL_DIR)

  // 4. 安装
  await install(getInfPath(INSTALL_DIR))

  // 5. 等待
  const ok = await waitForDevice()
  if (ok) {
    log('VB-Cable installed successfully! 🎉')
  } else {
    warn('驱动安装完成但设备未出现——可能需要重启系统')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[get-driver] fatal:', err)
  process.exit(1)
})