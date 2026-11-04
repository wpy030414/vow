// audio-archive — 上行录音落盘（可选功能，DECISIONS A23）
//
// 只负责把手机上传的 PCM 块按会话写成 WAV 文件，不参与虚拟麦克风 / ASR 链路：
//   - 关闭时本模块根本不被实例化，录音热路径零开销
//   - 开启时按会话首个音频块惰性建文件；会话销毁 / 进程退出时回填真实长度并关闭
//   - 写盘失败只告警一次并放弃该会话，绝不影响录音主链路

import {
  closeSync,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
  type WriteStream,
} from 'node:fs'
import { join } from 'node:path'

/** WAV 头中「长度未知」的占位值——进程被强杀时留在文件里，下次启动修补 */
const PLACEHOLDER_U32 = 0xffffffff

/** WAV 头长度字段偏移 */
const RIFF_SIZE_OFFSET = 4
const DATA_SIZE_OFFSET = 40

/** 构造 44 字节 RIFF/WAVE 头（PCM16）；长度传 PLACEHOLDER_U32 表示「仍在录制」 */
export function buildWavHeader(dataBytes: number, sampleRate: number, channels = 1): Buffer {
  const buf = Buffer.alloc(44)
  const unknown = dataBytes === PLACEHOLDER_U32
  const byteRate = sampleRate * channels * 2
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(unknown ? PLACEHOLDER_U32 : dataBytes + 36, RIFF_SIZE_OFFSET)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16) // fmt 块长度
  buf.writeUInt16LE(1, 20) // 编码：PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(channels * 2, 32) // blockAlign
  buf.writeUInt16LE(16, 34) // 位深
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataBytes, DATA_SIZE_OFFSET)
  return buf
}

/** 把单个 WAV 的占位长度补成真实长度；返回是否发生了修补 */
function finalizeWav(file: string): boolean {
  const fd = openSync(file, 'r+')
  try {
    const head = Buffer.alloc(44)
    if (readSync(fd, head, 0, 44, 0) !== 44) return false
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      return false
    }
    if (head.readUInt32LE(RIFF_SIZE_OFFSET) !== PLACEHOLDER_U32) return false // 已完整落盘
    const dataBytes = Math.max(0, fstatSync(fd).size - 44)
    const header = buildWavHeader(dataBytes, head.readUInt32LE(24))
    writeSync(fd, header, 0, 44, 0)
    return true
  } finally {
    closeSync(fd)
  }
}

/**
 * 启动时修补遗留录音（进程被强杀 / 断电时会残留占位头）。
 * 目录不存在或个别文件损坏只告警，绝不阻断启动。
 */
export function finalizeOrphanWavs(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // 首次运行：目录尚不存在
  }
  for (const name of names) {
    if (!name.endsWith('.wav')) continue
    try {
      if (finalizeWav(join(dir, name))) console.warn(`[Archive] 已修补未收尾的录音：${name}`)
    } catch (err) {
      console.warn(`[Archive] 修补 ${name} 失败：${String(err)}`)
    }
  }
}

/** 单会话的落盘句柄 */
interface ArchiveSession {
  stream: WriteStream
  file: string
  sampleRate: number
  dataBytes: number
  failed: boolean
}

export class AudioArchive {
  private readonly sessions = new Map<string, ArchiveSession>()
  private dirReady = false

  constructor(private readonly dir: string) {
    finalizeOrphanWavs(dir)
  }

  /** 记录一块上行音频；会话首个块触发建文件（采样率取该块原值，不做重采样） */
  write(sessionId: string, base64Pcm: string, sampleRate: number): void {
    const existing = this.sessions.get(sessionId)
    const session = existing ?? this.openSession(sessionId, sampleRate || 44100)
    if (!session) return
    if (session.failed) return

    const pcm = Buffer.from(base64Pcm, 'base64')
    if (pcm.length === 0) return
    session.stream.write(pcm)
    session.dataBytes += pcm.length
  }

  /** 收尾单个会话：回填真实长度并关闭文件 */
  close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve()
    this.sessions.delete(sessionId)
    if (session.failed) {
      session.stream.destroy()
      return Promise.resolve()
    }
    // 头已按占位长度写过，不能再追加一个头：用独立 fd 改文件偏移 4 / 40 处的两个 u32。
    // 不走流自身的 position 覆写——那只在「流内尚未写入任何数据」时成立，已写入后再
    // 回退 position 会抛 ERR_STREAM_WRITE_AFTER_END 类的错或静默丢弃。
    // 两处都不跨扇区边界，非对齐覆写（缓冲区≥4 字节时）不会触发 read-modify-write 边界问题。
    return new Promise((resolve) => {
      session.stream.end(() => {
        try {
          const header = buildWavHeader(session.dataBytes, session.sampleRate)
          const fd = openSync(session.file, 'r+')
          try {
            writeSync(fd, header, RIFF_SIZE_OFFSET, 4, RIFF_SIZE_OFFSET)
            writeSync(fd, header, DATA_SIZE_OFFSET, 4, DATA_SIZE_OFFSET)
          } finally {
            closeSync(fd)
          }
        } catch (err) {
          console.warn(`[Archive] 收尾回填失败（文件仍可播放但不含长度信息）：${String(err)}`)
        }
        resolve()
      })
    })
  }

  /** 进程退出：所有会话一次性收尾 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private openSession(sessionId: string, sampleRate: number): ArchiveSession | null {
    try {
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true })
        this.dirReady = true
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const short = sessionId.slice(-8)
      const file = join(this.dir, `${stamp}_${short}_${sampleRate}Hz.wav`)
      const stream = createWriteStream(file, { flags: 'w' })
      stream.on('error', (err) => {
        const current = this.sessions.get(sessionId)
        if (!current || current.failed) return
        current.failed = true
        console.warn(`[Archive] 写入失败，放弃本次录音 ${file}：${String(err)}`)
      })
      stream.write(buildWavHeader(PLACEHOLDER_U32, sampleRate))
      const session: ArchiveSession = { stream, file, sampleRate, dataBytes: 0, failed: false }
      this.sessions.set(sessionId, session)
      console.log(`[Archive] 开始录制：${file}`)
      return session
    } catch (err) {
      console.warn(`[Archive] 无法创建录音文件：${String(err)}`)
      return null
    }
  }
}
