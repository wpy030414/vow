// scripts/get-driver.ts — 下载并安装 VB-Cable 虚拟音频驱动
//
// 用法：pnpm get-driver（需管理员权限）
// 驱动包缓存于 vendor/VBCABLE/，重复运行跳过下载
//
// ── 为什么不能只用 pnputil ──
// VB-CABLE 是「根枚举虚拟设备」：两个 INF 都声明 HardwareId=VBAudioVACWDM，
// 设备实例形如 ROOT\VBAudioVACWDM。`pnputil /add-driver <inf> /install` 只把驱动包
// 登记进驱动仓库，并且**仅对当前已存在的匹配设备生效**——而设备节点本身还不存在，
// 于是既不创建设备、也不注册服务，静默"成功"后什么都不会发生。
//
//   设备节点必须由厂商安装器 VBCABLE_Setup_x64.exe 创建。
//   且安装完成后**需要重启系统**，CABLE 端点才会出现在系统中。

import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createWriteStream, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { pipeline } from 'node:stream/promises'
import { createPortAudio } from '@vow/portaudio'

const req = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const VB_CABLE_DOWNLOAD_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'
const VB_CABLE_KEYWORD = 'CABLE'
const VB_CABLE_SERVICE_NAME = 'VBAudioVACMME'
const VB_CABLE_SETUP_X64 = 'VBCABLE_Setup_x64.exe'
const VB_CABLE_SETUP_X86 = 'VBCABLE_Setup.exe'
const VB_CABLE_WIN10_INF = 'vbMmeCable64_win10.inf'
// 本脚本早期误装的旧世代 INF（pnputil 曾把它们塞进驱动仓库）——需要清掉，避免与 win10 包抢设备
const VB_CABLE_LEGACY_INF_RE = /vbmmecable\S*_(2003|xp|vista|win7)\.inf$/i

const INSTALL_DIR = join(repoRoot, 'vendor', 'VBCABLE')
const pa = createPortAudio()
const execFileAsync = promisify(execFile)

// ─── 工具 ───

function log(msg: string) { console.log(`[get-driver] ${msg}`) }
function warn(msg: string) { console.warn(`[get-driver] ⚠ ${msg}`) }

async function scanForCable(): Promise<boolean> {
  // 方式 1：@vow/portaudio（koffi→PortAudio）设备扫描（最可靠）
  try {
    const devices = await pa.getDevices()
    if (devices.some(
      (d) => d.name.toUpperCase().includes(VB_CABLE_KEYWORD) && d.maxOutputChannels > 0,
    )) return true
  } catch { /* 回退到服务检测 */ }

  // 方式 2：Windows 服务检测（execFile 异步真判真——旧版同步 exec 永不抛错，此前恒返回 true）
  return hasService()
}

/** sc query 退出码 0 = 服务存在（即驱动已绑定到设备） */
async function hasService(): Promise<boolean> {
  try {
    await execFileAsync('sc', ['query', VB_CABLE_SERVICE_NAME], { timeout: 3000 })
    return true
  } catch {
    return false
  }
}

async function download(dir: string): Promise<void> {
  const zipPath = join(dir, basename(VB_CABLE_DOWNLOAD_URL)) // VBCABLE_Driver_Pack45.zip
  const legacyZip = join(dir, 'VBCABLE_Driver_Pack43.zip') // 早期下载遗留名
  const cached = [zipPath, legacyZip].find((p) => existsSync(p))
  if (cached) {
    log('ZIP already downloaded, extracting...')
    extract(cached, dir)
    return
  }

  log(`downloading from ${VB_CABLE_DOWNLOAD_URL} ...`)
  await new Promise<void>((resolvePromise, reject) => {
    const file = createWriteStream(zipPath)
    get(VB_CABLE_DOWNLOAD_URL, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location
        if (redirectUrl) {
          file.close()
          get(redirectUrl, (res2) => pipeline(res2, file).then(resolvePromise).catch(reject)).on('error', reject)
          return
        }
      }
      if (response.statusCode !== 200) { file.close(); reject(new Error(`HTTP ${response.statusCode}`)); return }
      pipeline(response, file).then(resolvePromise).catch(reject)
    }).on('error', reject)
  })

  log('extracting...')
  extract(zipPath, dir)
  log('extracted')
}

function extract(zipPath: string, dir: string): void {
  const AdmZip = req('adm-zip') as new (p: string) => { extractAllTo: (t: string, o: boolean) => void }
  new AdmZip(zipPath).extractAllTo(dir, true)
}

/** 厂商安装器路径（64 位优先） */
function getSetupPath(dir: string): string {
  const files = readdirSync(dir)
  const x64 = files.find((f) => f.toLowerCase() === VB_CABLE_SETUP_X64.toLowerCase())
  if (x64) return join(dir, x64)
  const x86 = files.find((f) => f.toLowerCase() === VB_CABLE_SETUP_X86.toLowerCase())
  if (x86) return join(dir, x86)
  throw new Error(`未找到厂商安装器 ${VB_CABLE_SETUP_X64}——请检查 ${INSTALL_DIR}`)
}

// ─── 驱动包仓库清理 ───

interface DriverPackage { published: string; original: string | null }

/** 解析 `pnputil /enum-drivers`：成对抓取 oemNN.inf（发布名）与其原始 INF 名 */
async function listDriverPackages(): Promise<DriverPackage[]> {
  const { stdout } = await execFileAsync('pnputil', ['/enum-drivers'], { timeout: 20_000, maxBuffer: 8 << 20 })
  const pkgs: DriverPackage[] = []
  let cur: DriverPackage | null = null
  for (const line of stdout.split(/\r?\n/)) {
    const pub = line.match(/(oem\d+\.inf)/i)
    if (pub) { cur = { published: pub[1], original: null }; pkgs.push(cur); continue }
    const orig = line.match(/(\S+\.inf)/i)
    if (orig && cur && cur.original === null) cur.original = orig[1]
  }
  return pkgs
}

/** 删除本脚本早期误装的旧世代 VB-Cable 驱动包（保留 win10 包） */
async function purgeLegacyPackages(): Promise<void> {
  let pkgs: DriverPackage[]
  try { pkgs = await listDriverPackages() } catch (err) { warn(`枚举驱动仓库失败，跳过清理：${String(err)}`); return }

  const legacy = pkgs.filter((p) => p.original && VB_CABLE_LEGACY_INF_RE.test(p.original))
  if (legacy.length === 0) { log('驱动仓库无旧世代 VB-Cable 包，无需清理'); return }

  for (const p of legacy) {
    log(`清理旧世代驱动包 ${p.published} (${p.original}) ...`)
    try {
      await execFileAsync('pnputil', ['/delete-driver', p.published, '/force'], { timeout: 20_000 })
    } catch (err) {
      warn(`删除 ${p.published} 失败（可忽略）：${String(err)}`)
    }
  }
}

// ─── 安装 ───

/** 运行厂商安装器创建根枚举设备（GUI 程序，完成时会弹提示框，需等其退出） */
async function installViaVendorSetup(setupPath: string): Promise<void> {
  log(`running vendor installer: ${setupPath}`)
  log('（安装器窗口可能短暂显示"未响应"，属正常；完成时会弹出提示框——请点击确认）')
  try {
    await execFileAsync(setupPath, [], { timeout: 10 * 60_000, windowsHide: false })
  } catch (err) {
    // 安装器可能返回非零退出码却已完成安装，交由后续服务检测判定
    warn(`安装器退出码非零（继续验证）：${String(err)}`)
  }
}

async function waitForService(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now()
  log('waiting for CABLE service to register...')
  for (;;) {
    if (await hasService()) { log('service VBAudioVACMME registered!'); return true }
    if (Date.now() - start > timeoutMs) { warn('timeout — service not registered'); return false }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

// ─── 入口 ───

async function main() {
  // 1. 快速检查
  if (await scanForCable()) {
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

  // 3.5 校验 win10 INF 存在（厂商安装器在 Win10/11 上会用它）
  if (!readdirSync(INSTALL_DIR).some((f) => f.toLowerCase() === VB_CABLE_WIN10_INF.toLowerCase())) {
    warn(`未找到 ${VB_CABLE_WIN10_INF}——安装器可能选错驱动，请检查驱动包`)
  }

  // 4. 清理早期误装的旧世代驱动包
  await purgeLegacyPackages()

  // 5. 用厂商安装器创建根枚举设备（pnputil 无法做到这一点）
  await installViaVendorSetup(getSetupPath(INSTALL_DIR))

  // 6. 验证：设备若免重启出现则直接成功，否则确认服务已注册 → 提示重启
  if (await scanForCable()) {
    log('VB-Cable installed successfully! 🎉')
    return
  }
  if (await waitForService()) {
    log('驱动已注册。系统需要**重启**后 CABLE 设备才会出现（VB-Audio 官方要求）。')
    log('重启后请运行: pnpm portaudio-check 验证设备')
    return
  }
  warn('驱动安装完成但服务未注册——请检查上方安装器输出')
  process.exit(1)
}

main()
  .catch((err) => {
    console.error('[get-driver] fatal:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await pa.shutdown()
  })
