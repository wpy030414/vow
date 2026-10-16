// scripts/run-when-os-starts.ts
// 注册 / 注销 Windows 开机自启动：当前项目根目录下运行 pnpm start
//
//   pnpm run-when-os-starts [install|uninstall|status]
//
// 实现：向 HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写入 / 删除
// 一条以 pnpm 启动本项目的注册表值；启动介质为 .vow/startup-launcher.vbs
// （无窗口运行，无闪烁 CMD），注册表值名 = vow-startup。

import { execSync, spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const DOT_VOW = resolve(ROOT, '.vow')
const LAUNCHER = resolve(DOT_VOW, 'startup-launcher.vbs')

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const REG_VALUE = 'vow-startup'

const cmd = process.argv[2] ?? 'install'

// ── helpers ──

function ensureDotVow() {
  if (!existsSync(DOT_VOW)) mkdirSync(DOT_VOW, { recursive: true })
}

/** 写入无窗口启动 VBS：CWD 切到项目根后以隐藏窗口执行 pnpm start */
function writeLauncher() {
  ensureDotVow()
  // VBS Run 第二个参数 0 = 隐藏窗口, False = 不等待完成
  const vbs = [
    'Dim WshShell',
    `Set WshShell = CreateObject("WScript.Shell")`,
    `WshShell.CurrentDirectory = "${ROOT.replace(/\\/g, '\\\\')}"`,
    `WshShell.Run "pnpm start", 0, False`,
    'Set WshShell = Nothing',
  ].join('\r\n')
  writeFileSync(LAUNCHER, vbs, 'utf-8')
  console.log(`  ✓ 写入启动器: ${LAUNCHER}`)
}

function regAdd() {
  execSync(
    `reg add "${REG_PATH}" /v ${REG_VALUE} /t REG_SZ /d "${LAUNCHER.replace(/\\/g, '\\\\')}" /f`,
    { stdio: 'pipe', windowsHide: true },
  )
}

function regDelete() {
  try {
    execSync(`reg delete "${REG_PATH}" /v ${REG_VALUE} /f`, {
      stdio: 'pipe',
      windowsHide: true,
    })
  } catch {
    // 值不存在也幂等
  }
}

function regQuery(): string | null {
  try {
    const out = execSync(
      `reg query "${REG_PATH}" /v ${REG_VALUE}`,
      { stdio: 'pipe', windowsHide: true, encoding: 'utf-8' },
    )
    // 取出 REG_SZ 行中的值
    const m = out.match(/REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** 检测 vow 后端是否已在运行（连 localhost:48085 TCP，超时 1.5s） */
function isAlreadyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: 48085 }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.on('error', () => resolve(false))
    sock.setTimeout(1500, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/** 后台启动 pnpm start（通过 VBS 启动器——它走 Shell.Run 全环境 PATH，无窗口） */
function startInBackground() {
  // VBS 文件已在 install 流程中写入；直接用 cscript 触发它
  const child = spawn('cscript', ['//Nologo', LAUNCHER], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

// ── commands ──

switch (cmd) {
  case 'install': {
    const existing = regQuery()
    const alreadyReg = !!(existing && existsSync(LAUNCHER))
    if (alreadyReg) {
      console.log('[vow] 开机自启已注册，跳过（幂等）')
      console.log(`  注册表: ${REG_PATH}\\${REG_VALUE}`)
    } else {
      console.log('[vow] 注册 Windows 开机自启动...')
      writeLauncher()
      regAdd()
      console.log(`  ✓ 已注册为 "${REG_VALUE}"`)
      console.log(`  启动命令: ${LAUNCHER}`)
      console.log('  如需取消: pnpm run-when-os-starts uninstall')
    }
    // 即刻后台启动——已有实例则跳过
    const running = await isAlreadyRunning()
    if (running) {
      console.log('  ⏭ 服务已在运行，跳过启动')
    } else {
      console.log('  ▶ 后台启动 vow 服务...')
      startInBackground()
      console.log('  ✓ 已后台启动')
    }
    process.exit(0)
  }

  case 'uninstall':
  case 'remove': {
    console.log('[vow] 移除 Windows 开机自启动...')
    regDelete()
    try {
      if (existsSync(LAUNCHER)) unlinkSync(LAUNCHER)
      console.log(`  ✓ 已移除启动器: ${LAUNCHER}`)
    } catch {
      // 文件不存在也无妨
    }
    console.log(`  ✓ 已移除注册表项 "${REG_VALUE}"`)
    break
  }

  case 'status': {
    const val = regQuery()
    if (val) {
      console.log(`[vow] 开机自启: 已注册 ✓`)
      console.log(`  注册表: ${REG_PATH}\\${REG_VALUE}`)
      console.log(`  指向:    ${val}`)
      console.log(`  启动器: ${existsSync(LAUNCHER) ? '存在' : '缺失 ⚠'}`)
    } else {
      console.log('[vow] 开机自启: 未注册')
    }
    break
  }

  default:
    console.error(`未知子命令: ${cmd}。可用: install | uninstall | status`)
    process.exit(1)
}