// config.test.ts — config.yml 加载与归一化

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from './config'

const dirs: string[] = []

function makeRoot(configYml?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vow-config-'))
  dirs.push(dir)
  if (configYml !== undefined) writeFileSync(join(dir, 'config.yml'), configYml, 'utf8')
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('normalizeConfig', () => {
  it('空 / 非对象输入 → 全默认值（虚拟麦克风关、端口 48085）', () => {
    for (const raw of [undefined, null, 42, 'text', []]) {
      const cfg = normalizeConfig(raw)
      expect(cfg.port).toBe(DEFAULT_CONFIG.port)
      expect(cfg.virtualAudio.enabled).toBe(false)
    }
  })

  it('缺项逐项回退，不整份丢弃', () => {
    const cfg = normalizeConfig({ virtualAudio: { enabled: true } })
    expect(cfg.virtualAudio.enabled).toBe(true)
    expect(cfg.port).toBe(DEFAULT_CONFIG.port)
  })

  it('字符串布尔容错（yaml 引号手写场景）', () => {
    expect(normalizeConfig({ virtualAudio: { enabled: 'true' } }).virtualAudio.enabled).toBe(true)
    expect(normalizeConfig({ virtualAudio: { enabled: 'false' } }).virtualAudio.enabled).toBe(false)
  })

  it('非法端口回退默认；合法端口采纳', () => {
    expect(normalizeConfig({ port: 0 }).port).toBe(48085)
    expect(normalizeConfig({ port: 70000 }).port).toBe(48085)
    expect(normalizeConfig({ port: '48090' }).port).toBe(48090)
    expect(normalizeConfig({ port: 48100 }).port).toBe(48100)
  })
})

describe('loadConfig', () => {
  it('文件缺失 → 全默认值（不报错）', () => {
    expect(loadConfig({ repoRoot: makeRoot(), env: {} })).toEqual(DEFAULT_CONFIG)
  })

  it('读取 yaml 并归一化', () => {
    const root = makeRoot(`port: 48100\nvirtualAudio:\n  enabled: true\n`)
    const cfg = loadConfig({ repoRoot: root, env: {} })
    expect(cfg.port).toBe(48100)
    expect(cfg.virtualAudio.enabled).toBe(true)
  })

  it('解析失败 → 回退默认值，不抛', () => {
    const root = makeRoot('port: [unclosed\n  bad: : :\n')
    const cfg = loadConfig({ repoRoot: root, env: {} })
    expect(cfg.port).toBe(DEFAULT_CONFIG.port)
    expect(cfg.virtualAudio.enabled).toBe(false)
  })

  it('PORT 环境变量优先级高于 config.yml', () => {
    const root = makeRoot('port: 48100\n')
    expect(loadConfig({ repoRoot: root, env: { PORT: '49000' } }).port).toBe(49000)
  })

  it('PORT 非法时忽略，退回文件值', () => {
    const root = makeRoot('port: 48100\n')
    expect(loadConfig({ repoRoot: root, env: { PORT: 'abc' } }).port).toBe(48100)
  })

  it('默认 shape：virtualAudio.enabled=false，且不存在 hostAudio 之类的无效开关', () => {
    const cfg = loadConfig({ repoRoot: makeRoot(), env: {} })
    expect(cfg.virtualAudio).toEqual({ enabled: false })
    expect(Object.keys(cfg).sort()).toEqual(['port', 'virtualAudio'])
  })
})
