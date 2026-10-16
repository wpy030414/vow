// audio-route — 把外放音频从「听筒」扳回「扬声器」的跨平台兜底
//
// 现象：移动浏览器上，页面一旦调用 getUserMedia 取得麦克风，系统音频会话就被切入
// 「录放 / 通话」类别，此后所有外放——包括本应用用 Web Audio 播出的宿主系统音频
// ——都会被路由到听筒；即便停止录音，会话也常赖在录放态不归还
// （WebKit bug 295889 / Apple 论坛 657321）。本模块按平台能力各自兜底：
//
//   iOS（Safari 16.4+）：AudioSession API。显式声明会话类型即可指定路由——
//     'play-and-record' = 麦克风 + 外放（扬声器）
//     'playback'        = 纯媒体播放（扬声器，高保真）
//     'auto'            = 交还浏览器自动判定
//   Android（Chrome 110+）：AudioContext.setSinkId()。枚举音频输出设备，仅当存在
//     标签明确指向「扬声器」的设备时才切换；找不到就保持系统默认，绝不误切。

/** iOS AudioSession 的会话类型子集（Safari 16.4+；其余浏览器无此对象） */
export type AudioSessionType = 'auto' | 'playback' | 'play-and-record'

/** AudioSession 的最小结构（尚未进 TS DOM lib，故自持声明） */
interface AudioSessionLike {
  type: string
}
interface NavigatorWithAudioSession extends Navigator {
  audioSession?: AudioSessionLike
}

/** 设置 iOS 音频会话类型。非 Safari / 无此 API 时静默跳过（交由 setSinkId 分支兜底）。 */
export function setAudioSessionType(type: AudioSessionType): void {
  const session = (navigator as NavigatorWithAudioSession).audioSession
  if (!session) return
  try {
    if (session.type !== type) session.type = type
  } catch {
    /* 只读 / 受限环境 */
  }
}

/** 按「是否录音中 / 是否开启输出」的现状挑选 iOS 会话类型：
 *  输出开关开着时，优先 playback（无通知栏录音指示器，更优雅）；
 *  一旦录音中则强制 play-and-record；
 *  停录后若输出仍开着则落回 playback——不卡类别升级，通知栏干净。 */
export function syncAudioSession(recording: boolean, outputEnabled: boolean): void {
  if (recording) setAudioSessionType('play-and-record')
  else if (outputEnabled) setAudioSessionType('playback')
  else setAudioSessionType('auto')
}

/** 设备标签中指向「扬声器」的关键字（中英） */
const SPEAKER_LABEL_RE = /speaker|loudspeaker|loud\b|外放|扬声器|扩音/i

interface AudioContextWithSink extends AudioContext {
  readonly sinkId?: string
  setSinkId?(sinkId: string): Promise<void>
}

/** 枚举到明确的「扬声器」输出设备 id（标签经麦克风授权后才可见；无则 null） */
async function findLoudspeakerId(): Promise<string | null> {
  const md = navigator.mediaDevices
  if (!md?.enumerateDevices) return null
  try {
    const devices = await md.enumerateDevices()
    const hit = devices.find(
      (d) =>
        d.kind === 'audiooutput' &&
        d.deviceId !== '' &&
        d.deviceId !== 'default' &&
        SPEAKER_LABEL_RE.test(d.label),
    )
    return hit?.deviceId ?? null
  } catch {
    return null
  }
}

/** Android/Chrome：把 AudioContext 的输出切到扬声器。
 *  仅在枚举到明确的扬声器设备时才动手——找不到就保持系统默认，绝不误切。 */
export async function preferLoudspeakerSink(ctx: AudioContext): Promise<void> {
  const c = ctx as AudioContextWithSink
  if (typeof c.setSinkId !== 'function') return // Safari 无此 API：由 AudioSession 分支负责
  try {
    const id = await findLoudspeakerId()
    if (!id || c.sinkId === id) return
    await c.setSinkId!(id)
  } catch {
    /* 无权限 / 设备消失：保持默认输出 */
  }
}
