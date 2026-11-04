// audio-archive.test.ts — 录音落盘：WAV 头、分块写入、收尾回填、异常修补

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioArchive, buildWavHeader, finalizeOrphanWavs } from './audio-archive'

const dirs: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vow-archive-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** PCM16LE 静音块（n 个采样点） */
function silence(n: number): string {
  return Buffer.alloc(n * 2).toString('base64')
}

const PLACEHOLDER = 0xffffffff

describe('buildWavHeader', () => {
  it('已知长度：RIFF size = data + 36，data size 正确，字段齐全', () => {
    const h = buildWavHeader(3200, 16000)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.toString('ascii', 8, 12)).toBe('WAVE')
    expect(h.toString('ascii', 12, 16)).toBe('fmt ')
    expect(h.readUInt16LE(20)).toBe(1) // PCM
    expect(h.readUInt16LE(22)).toBe(1) // 单声道
    expect(h.readUInt32LE(24)).toBe(16000)
    expect(h.readUInt32LE(28)).toBe(32000) // byteRate
    expect(h.readUInt16LE(32)).toBe(2) // blockAlign
    expect(h.readUInt16LE(34)).toBe(16) // 位深
    expect(h.toString('ascii', 36, 40)).toBe('data')
    expect(h.readUInt32LE(4)).toBe(3200 + 36)
    expect(h.readUInt32LE(40)).toBe(3200)
  })

  it('未知长度：两处 size 均为占位值', () => {
    const h = buildWavHeader(PLACEHOLDER, 44100)
    expect(h.readUInt32LE(4)).toBe(PLACEHOLDER)
    expect(h.readUInt32LE(40)).toBe(PLACEHOLDER)
  })
})

describe('AudioArchive', () => {
  it('默认不写入 → close 无事发生；写入后才产生文件', async () => {
    const dir = makeDir()
    const archive = new AudioArchive(dir) // 空目录：什么都不做
    archive.write('vow-aaaaaaaa', silence(100), 16000)
    await archive.close('vow-aaaaaaaa')
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^\d{4}-.*_aaaaaaaa_16000Hz\.wav$/)
  })

  it('收到音频块后立即落盘，收尾回填真实长度（可被播放器识别）', async () => {
    const dir = makeDir()
    const archive = new AudioArchive(dir)
    archive.write('vow-aaaaaaaa', silence(8000), 16000) // 1s
    archive.write('vow-aaaaaaaa', silence(8000), 16000) // 再 1s
    await archive.close('vow-aaaaaaaa')

    const [name] = readdirSync(dir)
    const buf = readFileSync(join(dir, name))
    expect(buf.length).toBe(44 + 32000)
    expect(buf.readUInt32LE(4)).toBe(32000 + 36)
    expect(buf.readUInt32LE(40)).toBe(32000)
    expect(buf.readUInt32LE(24)).toBe(16000) // 采样率保持原值
  })

  it('会话隔离：两个会话分别成文件、互不串扰', async () => {
    const dir = makeDir()
    const archive = new AudioArchive(dir)
    archive.write('vow-aaaaaaaa', silence(100), 16000)
    archive.write('vow-bbbbbbbb', silence(200), 48000)
    await archive.closeAll()
    const files = readdirSync(dir).sort()
    expect(files).toHaveLength(2)
    expect(files.some((f) => f.includes('_aaaaaaaa_') && f.includes('_16000Hz'))).toBe(true)
    expect(files.some((f) => f.includes('_bbbbbbbb_') && f.includes('_48000Hz'))).toBe(true)
  })

  it('重复 close / 未知会话 close 不抛错', async () => {
    const dir = makeDir()
    const archive = new AudioArchive(dir)
    archive.write('vow-aaaaaaaa', silence(10), 16000)
    await archive.close('vow-aaaaaaaa')
    await archive.close('vow-aaaaaaaa')
    await archive.close('vow-unknown')
  })
})

describe('finalizeOrphanWavs', () => {
  it('修补占位头，并按文件实际大小回填；已完整的文件保持不变', () => {
    const dir = makeDir()
    // 模拟进程被强杀：头部占位 + 4 字节数据
    const partial = Buffer.concat([buildWavHeader(PLACEHOLDER, 16000), Buffer.alloc(4)])
    writeFileSync(join(dir, 'a.wav'), partial)
    // 已完整落盘的文件：不应被改写
    const complete = Buffer.concat([buildWavHeader(4, 16000), Buffer.alloc(4)])
    writeFileSync(join(dir, 'b.wav'), complete)
    writeFileSync(join(dir, 'ignore.txt'), 'x')

    finalizeOrphanWavs(dir)

    const a = readFileSync(join(dir, 'a.wav'))
    expect(a.readUInt32LE(4)).toBe(4 + 36)
    expect(a.readUInt32LE(40)).toBe(4)
    expect(readFileSync(join(dir, 'b.wav')).equals(complete)).toBe(true)
  })

  it('目录不存在 / 非 WAV 垃圾文件均不抛错', () => {
    expect(() => finalizeOrphanWavs(join(makeDir(), 'missing'))).not.toThrow()
    const dir = makeDir()
    writeFileSync(join(dir, 'broken.wav'), 'not a wav at all')
    expect(() => finalizeOrphanWavs(dir)).not.toThrow()
  })
})
