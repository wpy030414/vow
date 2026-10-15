// scripts/portaudio-check.ts —— @vow/portaudio 冒烟脚本
//
// 用法：
//   pnpm portaudio-check                          # 枚举全部设备
//   pnpm portaudio-check --cable --seconds 1      # 自动挑选 CABLE WASAPI 候选，写 1s 440Hz 正弦
//   pnpm portaudio-check --device 21 --seconds 1  # 向指定设备 id 写 1s 440Hz 正弦（立体声）
//
// 用途：验证 koffi→PortAudio 链路（枚举/开流/写出/释放），并作为 DLL 升级后的回归手段

import { createPortAudio } from '@vow/portaudio'

const SAMPLE_RATE = 44100
const FRAMES = 1024
const CHANNELS = 2
const TONE_HZ = 440
const TONE_GAIN = 0.2

const args = process.argv.slice(2)
function argValue(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(): Promise<void> {
  const pa = createPortAudio()
  console.log(`supported = ${pa.supported}`)
  if (!pa.supported) {
    console.error('PortAudio 不可用（非 win32 或 DLL/依赖缺失）')
    process.exitCode = 1
    return
  }

  const devices = await pa.getDevices()
  console.log(`设备总数: ${devices.length}`)
  for (const d of devices) {
    console.log(
      `  #${d.id} ${d.name} [${d.hostAPIName}] in=${d.maxInputChannels} out=${d.maxOutputChannels} sr=${d.defaultSampleRate}`,
    )
  }

  const seconds = Number(argValue('seconds') ?? 0)
  if (!seconds) {
    await pa.shutdown()
    return
  }

  let deviceId = argValue('device') !== undefined ? Number(argValue('device')) : undefined
  if (deviceId === undefined) {
    const candidates = devices
      .filter((d) => d.name.toUpperCase().includes('CABLE') && d.maxOutputChannels >= 2 && d.hostAPIName === 'Windows WASAPI')
      .sort((a, b) => Math.abs(a.maxOutputChannels - 2) - Math.abs(b.maxOutputChannels - 2))
    deviceId = candidates[0]?.id
    console.log(`自动选择 CABLE 候选: ${candidates[0]?.name ?? '(未找到)'}`)
  }
  if (deviceId === undefined) {
    console.error('未找到可用设备，退出')
    await pa.shutdown()
    process.exitCode = 1
    return
  }

  console.log(`向设备 #${deviceId} 写入 ${seconds}s ${TONE_HZ}Hz 正弦（${SAMPLE_RATE}Hz float32 立体声）...`)
  const stream = await pa.openOutput({ deviceId, sampleRate: SAMPLE_RATE, channelCount: CHANNELS })
  stream.onError((e) => console.error('stream error:', e.message))

  const totalBlocks = Math.ceil((seconds * SAMPLE_RATE) / FRAMES)
  let phase = 0
  for (let b = 0; b < totalBlocks; b++) {
    const buf = new Float32Array(FRAMES * CHANNELS)
    for (let i = 0; i < FRAMES; i++) {
      const v = Math.sin(phase) * TONE_GAIN
      phase += (2 * Math.PI * TONE_HZ) / SAMPLE_RATE
      buf[i * 2] = v
      buf[i * 2 + 1] = v
    }
    stream.write(buf)
    await new Promise((r) => setTimeout(r, 23)) // ≈实时节奏（与 server 主循环一致）
  }

  await stream.stop()
  await pa.shutdown()
  console.log('正弦写入完成 ✓')
}

main().catch((err) => {
  console.error('[portaudio-check] fatal:', err)
  process.exit(1)
})
