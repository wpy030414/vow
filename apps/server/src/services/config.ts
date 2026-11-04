// config — 仓库根 config.yml 的加载与归一化
//
// 约定（见 docs/DECISIONS.md A16）：除端口外，运行期配置都来自 config.yml；
// 环境变量仅 PORT 一个逃生口。文件缺失 / 解析失败一律落回内置默认值，绝不因配置问题启动失败。
//
// 注意配置的取舍：只有「真正存在选择」的项才进配置。宿主系统声回传（loopback）零驱动依赖、
// 无运行代价，恒开启，因此**没有开关**——不制造永远不会有人去关的配置项。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

export interface VirtualAudioConfig {
  /**
   * 手机音频写入 VB-Cable，使手机成为宿主系统麦克风。
   * 需用户自行安装 VB-Cable 驱动；关闭时不做任何探测、不产生任何告警。
   */
  enabled: boolean
}

export interface RecordingConfig {
  /**
   * 把手机上行录音按会话落盘为 WAV（`<repoRoot>/.vow/recordings/`），用于事后回听 / 留档。
   * 默认关闭：关闭时不创建目录、不触碰录音热路径。
   */
  enabled: boolean
}

export interface AppConfig {
  /** 服务端口；环境变量 PORT 优先于此处 */
  port: number
  virtualAudio: VirtualAudioConfig
  recording: RecordingConfig
}

/** 内置默认值——config.yml 缺项时的兜底 */
export const DEFAULT_CONFIG: AppConfig = {
  port: 48085,
  virtualAudio: { enabled: false },
  recording: { enabled: false },
}

/** 布尔归一化：接受 true/false，也容忍 yaml 里手写的字符串 */
function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 端口归一化：合法整数（1-65535）才采纳，否则回退默认 */
function asPort(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback
}

/** 取嵌套节（非对象一律视为缺省） */
function section(input: unknown, key: string): Record<string, unknown> {
  if (!input || typeof input !== 'object') return {}
  const value = (input as Record<string, unknown>)[key]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 原始解析结果 → AppConfig（纯函数，测试直接喂对象） */
export function normalizeConfig(raw: unknown): AppConfig {
  const root: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const va = section(root, 'virtualAudio')
  const rec = section(root, 'recording')
  return {
    port: asPort(root.port, DEFAULT_CONFIG.port),
    virtualAudio: {
      enabled: asBool(va.enabled, DEFAULT_CONFIG.virtualAudio.enabled),
    },
    recording: {
      enabled: asBool(rec.enabled, DEFAULT_CONFIG.recording.enabled),
    },
  }
}

export interface LoadConfigOptions {
  /** 仓库根——config.yml 所在目录 */
  repoRoot: string
  /** 环境变量（测试注入） */
  env?: NodeJS.ProcessEnv
}

/**
 * 读取 `<repoRoot>/config.yml`。
 * - 文件不存在 → 全默认值（不告警、不报错）
 * - 解析失败 → 全默认值 + 一条 warn（配置写坏了也照样能起来）
 * - PORT 环境变量优先于文件（唯一的逃生口：端口冲突 / 临时换端口）
 */
export function loadConfig(opts: LoadConfigOptions): AppConfig {
  const env = opts.env ?? process.env
  const filePath = join(opts.repoRoot, 'config.yml')

  let raw: unknown = {}
  if (existsSync(filePath)) {
    try {
      raw = parse(readFileSync(filePath, 'utf8'))
    } catch (err) {
      console.warn(`[Config] config.yml 解析失败，使用默认配置：${String(err)}`)
      raw = {}
    }
  }

  const cfg = normalizeConfig(raw)
  const envPort = env.PORT ? asPort(env.PORT, cfg.port) : cfg.port
  return { ...cfg, port: envPort }
}
