// EvaScreen — qwennote-eva 形态主界面：整屏一对眼睛
//
// ── 表达模型（对齐钉钉 SharpEyes 内部实现，docs/DECISIONS.md A24 附录）──
// 官方是「基底表情（base expression）+ 瞬时表情（transient expression）」双层叠加：
// 基底常驻表达当前会话状态，瞬时动作叠加播完后自动回落到基底。
//   base        idle / listening / connecting / offline
//   transient   blink · wink · eyebrowRaise · headNod · mouthOpen · happy · sad
// 瞬时动作词表取自 ACTION_NAME_*：EYE_WINK / EYEBROW_RAISE / HEAD_NOD / MOUTH_OPEN / NONE。
// 本项目里 wink 被重新定义为 `> <` 挤眼（摇晃手机触发），与 blink（竖线眨眼）在
// 形态与触发源上都区分开——官方 EYE_WINK 的可视化自由度在此。
// 观感规则：相似层级动作互斥（眨眼期间不叠别的），高优先级动作（开心/难过）可打断基底。
//
// ── 视觉规格（反编译来源见 A24）──
// 几何与表情语义来自千问 App 语音表情库：双眼中心距 ±70、单眼 80×120 r40
// （官方 60×120，全屏加宽）、眨眼 = 宽扁线、开心 = 眯成月牙（官方原为 60×50 眯眼
// 胶囊，本项目改用「上沿弯、下沿平」的非等厚月牙，见 happyPath）、难过 = 半睁宽眼
// + 下移。主色荧光绿 #63ffb4（钉钉 AI 系 celebrate 眼部色）。
//
// ── 形态约束（服务端强制）──
// 仅 Tap（整屏轻触切换录音）、无控制栏、无耳返与「转文字」开关（ASR 恒随录音）。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '../lib/utils'

interface EvaScreenProps {
  connecting: boolean
  connected: boolean
  recording: boolean
  audioLevel: number
  /** 麦克风错误（getUserMedia 拒绝等）——底部细字展示 */
  error: string | null
  /** 整屏轻触：已连接时切换录音（tap 语义）。调用方负责在同一次手势里申请传感器权限 */
  onToggleRecording: () => void
  /** 掉线时轻触重连 */
  onConnect: () => void
  /** 摇晃计数：每次手机摇晃 +1，变化即播放挤眼（App 层统一监听传感器） */
  shakeTick: number
}

/** 基底情绪：常驻，表达当前会话状态 */
type Base = 'idle' | 'listening' | 'connecting' | 'offline'

/** 瞬时动作（官方 ACTION_NAME_* 词表 + 情绪型 happy/sad） */
type Transient = 'blink' | 'wink' | 'eyebrowRaise' | 'headNod' | 'mouthOpen' | 'happy' | 'sad'

/** 瞬时动作配置：时长与优先级（高优先级可打断低优先级） */
const TRANSIENTS: Record<Transient, { ms: number; priority: number }> = {
  blink: { ms: 160, priority: 1 },
  // `> <` 挤眼需要「挤住—松开」的完整节奏，比 blink 长一拍
  wink: { ms: 900, priority: 2 },
  eyebrowRaise: { ms: 700, priority: 2 },
  headNod: { ms: 700, priority: 2 },
  mouthOpen: { ms: 600, priority: 2 },
  happy: { ms: 1200, priority: 3 },
  sad: { ms: 1400, priority: 3 },
}

/** 荧光绿（钉钉 AI 系 celebrate 眼部色） */
const EYE_GREEN = '#63ffb4'

/**
 * 眼睛基础几何（画布 760×520，中心 (380,260)）：
 * 双眼中心 ±130（间距 260），单眼 128×160 r64 —— 官方 60×120 / 间距 140 的等比放大版。
 * 画布刻意留足边距：眨眼时眼睛横向放大 1.625 倍，光晕最宽约 128×1.625+2×22 ≈ 252px，
 * 画布半宽 380 足以容纳「半间距 130 + 半光晕 126 + 模糊扩散」，不会碰到视口边。
 */
const EYE_W = 128
const EYE_H = 160
const EYE_R = 64
const EYE_CX = 380
const EYE_DX = 130
const EYE_CY = 260
/** 荧光晕外扩量：晕矩形 = 眼睛矩形 + 2×GLOW_PAD，与眼睛同组同帧缩放 */
const GLOW_PAD = 22

/**
 * `> <` 挤眼是**独立符号**，不是胶囊眼睛的形变——圆角矩形再怎么缩放也做不出尖角。
 * 因此 wink 时不复用眼睛图形，改为淡入一对 SVG 折线：
 *   左 `>`、右 `<`，各由两笔粗圆头线条组成，尖端朝内侧。
 */
function WinceSymbol({
  cx,
  side,
  opacity,
}: {
  cx: number
  side: 'left' | 'right'
  opacity: number
}) {
  // `>` 的尖端在右侧；`<` 镜像。尺寸与眼睛本体相称（眼半宽 64 / 半高 80）：
  // 竖向张角 ±62，尖端内伸 34，线宽 18（与眼睛同色）
  const tipX = cx + (side === 'left' ? 34 : -34)
  const backX = cx + (side === 'left' ? -34 : 34)
  const y0 = EYE_CY - 62
  const y1 = EYE_CY
  const y2 = EYE_CY + 62
  return <GlowStroke opacity={opacity} d={`M ${backX} ${y0} L ${tipX} ${y1} L ${backX} ${y2}`} />
}

/**
 * `X X` 掉线符号：每只眼一个叉，两条对角粗圆头线。
 * 与 `> <` 同属符号层——胶囊眼睛做不出交叉的斜线。
 */
function CrossSymbol({
  cx,
  side,
  opacity,
}: {
  cx: number
  side: 'left' | 'right'
  opacity: number
}) {
  // 叉的尺寸略小于眼睛本体（半宽 46 / 半高 56），保留十字中心处的小缺口
  const r = 46
  const ry = 56
  // 微妙地让左右两只叉的内倾方向相反，视觉上更像两只眼睛而非并排的 X
  const tilt = side === 'left' ? -6 : 6
  return (
    <g transform={`rotate(${tilt} ${cx} ${EYE_CY})`}>
      <GlowStroke
        opacity={opacity}
        d={`M ${cx - r} ${EYE_CY - ry} L ${cx + r} ${EYE_CY + ry} M ${cx + r} ${EYE_CY - ry} L ${cx - r} ${EYE_CY + ry}`}
      />
    </g>
  )
}

/**
 * 符号通用绘制：先画一层加粗模糊的荧光底，再叠实线。
 * 眼睛的「晕」是单独一层 rect 叠出来的，stroke 不会自带，不显式加就是死线条。
 */
function GlowStroke({ d, opacity }: { d: string; opacity: number }) {
  return (
    <g style={{ opacity, transition: 'opacity 160ms ease' }} aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={EYE_GREEN}
        strokeWidth="44"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.55}
        filter="url(#evaGlow)"
      />
      <path
        d={d}
        fill="none"
        stroke={EYE_GREEN}
        strokeWidth="18"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </g>
  )
}

/** 胶囊眼睛的 SVG 路径（超圆角矩形 = 短边即半径的圆角矩形） */
function capsulePath(cx: number): string {
  const x = cx - EYE_W / 2
  const y = EYE_CY - EYE_H / 2
  const w = EYE_W
  const h = EYE_H
  // 真正的胶囊：上下各一段**半径 = 半宽**的圆弧，左右两侧各一段竖直直边连接。
  //   圆弧半径 r = w/2 = 64，弧心在 (x+w/2, y+r) 与 (x+w/2, y+h-r)。
  // 若把圆角写成 EYE_R 并让上下直边长度为 0，就会退化成椭圆甚至正圆。
  const r = w / 2
  return [
    // 从左上圆弧起点开始，画顶部半圆到右上
    `M ${x} ${y + r}`,
    `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
    // 右侧竖直直边
    `V ${y + h - r}`,
    // 底部半圆从右画回左
    `A ${r} ${r} 0 0 1 ${x} ${y + h - r}`,
    // 左侧竖直直边回到起点
    'Z',
  ].join(' ')
}

/** 开心月牙：上沿圆弧半径（较弯，决定拱高） */
const HAPPY_TOP_R = 66
/** 开心月牙：下沿圆弧半径（**必须比上沿平**；上下同弧就是一条等厚香蕉，两端笨重） */
const HAPPY_BOTTOM_R = 120
/** 开心月牙：两端圆头半径（收口，同时决定最宽处的安全边） */
const HAPPY_TIP_R = 8

/**
 * 开心眼：非等厚月牙（上沿弯、下沿平、两端小圆头）。
 *
 * 轮廓由四段圆弧拼成——上沿（Ru）、右圆头（h）、下沿（Rl）、左圆头（h）。
 * 每个接缝都落在**两圆的切点**上：圆头内切于上沿圆、外切于下沿圆，
 * 相切两圆在切点处公切线唯一 → 切线方向沿整条轮廓处处连续，斜率没有突变。
 * 斜率不靠调贝塞尔控点去凑，而是由相切条件直接解出，没有「调得像」的余地。
 *
 * 上下沿取不同半径（Rl > Ru）让月牙**中段厚、两端薄**：等厚圆环拼出来的月牙，
 * 两端是同样粗的半圆头，看上去像香蕉，不像眯起来的眼睛。
 *
 * 此前「胶囊上半弧 + 抬高的下沿」的写法在几何上做不到：下沿要从竖直侧边出发、
 * 又必须向上收到中点，只能先向下折返，侧边处退化成尖刺（实测曲率半径 < 1px，
 * 约 154° 的转向挤在参数 t 的 0.2 区间内），中段还会冒出一个拐点（曲率变号）。
 *
 * 尺寸：月牙最宽处在两个圆头外侧，2(xE + h) = EYE_W，与常规胶囊同宽，
 * 切换前后眼睛的水平占位不变；垂直方向按外接矩形（上沿顶点 ~ 圆头最低点）居中。
 */
function happyPath(cx: number): string {
  const h = HAPPY_TIP_R
  const Ru = HAPPY_TOP_R
  const Rl = HAPPY_BOTTOM_R
  // 圆头圆心到中轴的距离：xE + h = EYE_W / 2
  const xE = EYE_W / 2 - h
  // 相切条件定出两个弧心落在圆头下方多深：上沿内含圆头（Ru - h），下沿外切圆头（Rl + h）
  const dTop = Math.sqrt((Ru - h) ** 2 - xE ** 2)
  const dBottom = Math.sqrt((Rl + h) ** 2 - xE ** 2)
  // 圆头圆心的 y：让外接矩形居中于 EYE_CY（上沿顶点在 ey + dTop - Ru，圆头最低点在 ey + h）
  const ey = EYE_CY + (Ru - h - dTop) / 2
  // 切点：上沿切点在「圆头 → 上沿弧心」的延长线上，下沿切点在「圆头 → 下沿弧心」连线上
  const top = (side: 1 | -1) => [cx + (side * xE * Ru) / (Ru - h), ey - (h * dTop) / (Ru - h)]
  const bottom = (side: 1 | -1) => [cx + (side * xE * Rl) / (Rl + h), ey + (h * dBottom) / (Rl + h)]
  const f = (v: number) => +v.toFixed(2)
  const [ulx, uly] = top(-1)
  const [urx, ury] = top(1)
  const [lrx, lry] = bottom(1)
  const [llx, lly] = bottom(-1)
  return [
    `M ${f(ulx)} ${f(uly)}`,
    `A ${f(Ru)} ${f(Ru)} 0 0 1 ${f(urx)} ${f(ury)}`, // 上沿：顺时针越过顶部
    `A ${f(h)} ${f(h)} 0 0 1 ${f(lrx)} ${f(lry)}`, // 右圆头：内切上沿、外切下沿
    `A ${f(Rl)} ${f(Rl)} 0 0 0 ${f(llx)} ${f(lly)}`, // 下沿：反向收回（更平）
    `A ${f(h)} ${f(h)} 0 0 1 ${f(ulx)} ${f(uly)}`, // 左圆头
    'Z',
  ].join(' ')
}

/** 眼睛组变换：基底姿态 + 瞬时动作的姿态覆盖 */
function eyeTransform(base: Base, transient: Transient | null, level: number): string {
  // 瞬时动作优先
  switch (transient) {
    case 'blink':
      return 'scale(1.625, 0.083)' // 官方眨眼：宽扁线
    case 'wink':
      // 眼睛本体不参与形变，只整体收缩淡出；`> <` 由独立的 WinceSymbol 层呈现
      return 'scale(0.72, 0.2)'
    case 'eyebrowRaise':
      return 'scale(1, 1.06) translateY(-6px)' // 挑眉：眼睛抬高
    case 'headNod':
      return 'scale(1, 1) translateY(10px)' // 点头：整体下移
    case 'mouthOpen':
      return 'scale(1.12, 1.16)' // 张嘴：惊讶放大
    case 'happy':
      return 'scale(1, 1)' // 开心不改尺寸：形状由 happyPath 的月牙表达
    case 'sad':
      return 'scale(1.5, 0.75) translateY(6px)' // 120×90 半睁 + 下垂
    default:
      break
  }
  switch (base) {
    case 'listening':
      return `scale(${1 + level * 0.1}, ${1 + level * 0.13})` // 随音量律动
    case 'connecting':
      return 'scale(0.7, 0.633)' // 56×76 小号
    case 'offline':
      // 掉线不用扁眼——由 CrossSymbol 的 `X X` 符号层呈现，眼睛本体淡出
      return 'scale(0.86, 0.86)'
    default:
      return 'scale(1, 1)'
  }
}

/** 过渡曲线：眨眼用快过渡（官方 4 帧合上），其余用带回弹的缓动 */
function eyeTransition(transient: Transient | null): string {
  if (transient === 'blink' || transient === 'wink') return 'transform 90ms ease-in'
  return 'transform 240ms cubic-bezier(0.34, 1.3, 0.64, 1)'
}

/**
 * 瞬时动作调度器：单一 active 位 + 优先级抢占 + 定时回落。
 * 同一时刻只播一个瞬时动作（官方 CompletionPolicy 语义），高优先级可打断低优先级。
 */
function useTransient(): {
  active: Transient | null
  play: (t: Transient) => void
} {
  const [active, setActive] = useState<Transient | null>(null)
  const timerRef = useRef<number | null>(null)
  const activeRef = useRef<Transient | null>(null)

  const clear = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  const play = useCallback((t: Transient) => {
    const current = activeRef.current
    // 低优先级不得打断高优先级
    if (current && TRANSIENTS[current].priority > TRANSIENTS[t].priority) return
    clear()
    activeRef.current = t
    setActive(t)
    timerRef.current = window.setTimeout(() => {
      activeRef.current = null
      setActive(null)
      timerRef.current = null
    }, TRANSIENTS[t].ms)
  }, [])

  useEffect(() => clear, [])
  return { active, play }
}

/**
 * 自主行为引擎：基底为可睁眼状态时随机眨眼（2.6–5.2s，20% 接双眨），
 * 并以较低频率穿插官方词表中的小动作（挑眉 / 点头 / 张嘴），模仿「活着」的微动作。
 */
function useIdleBehavior(enabled: boolean, play: (t: Transient) => void): void {
  useEffect(() => {
    if (!enabled) return
    const timers: number[] = []
    const schedule = (delay: number) => {
      timers.push(
        window.setTimeout(() => {
          const roll = Math.random()
          if (roll < 0.7) play('blink')
          else if (roll < 0.82) play('eyebrowRaise')
          else if (roll < 0.92) play('headNod')
          else play('mouthOpen')
          schedule(2600 + Math.random() * 2600)
        }, delay),
      )
    }
    schedule(1600 + Math.random() * 1600)
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [enabled, play])
}

export function EvaScreen({
  connecting,
  connected,
  recording,
  audioLevel,
  error,
  onToggleRecording,
  onConnect,
  shakeTick,
}: EvaScreenProps) {
  const { active, play } = useTransient()

  // ── 基底：会话状态决定（常驻） ──
  const base: Base = !connected
    ? connecting
      ? 'connecting'
      : 'offline'
    : recording
      ? 'listening'
      : 'idle'

  // ── 状态翻转 → 触发对应的瞬时动作（叠加层） ──
  // 录音开始：挑眉确认；录音结束：眯眼笑（ASR 收尾打字的眼色反馈）
  const prevRecordingRef = useRef(recording)
  useEffect(() => {
    const was = prevRecordingRef.current
    prevRecordingRef.current = recording
    if (recording && !was) play('eyebrowRaise')
    else if (!recording && was) play('happy')
  }, [recording, play])

  // 掉线：难过一下
  const prevConnectedRef = useRef(connected)
  useEffect(() => {
    const was = prevConnectedRef.current
    prevConnectedRef.current = connected
    if (was && !connected) play('sad')
  }, [connected, play])

  // ── 摇晃手机 → `> <` 挤眼 ──
  // 传感器由 App 层统一监听（权限在麦克风授权时一并申请），这里只消费计数变化。
  // 掉线时不响应：那时眼睛应当表达「难过」，不该被晃得挤眼
  const shakeRef = useRef(shakeTick)
  useEffect(() => {
    if (shakeTick === shakeRef.current) return
    shakeRef.current = shakeTick
    if (connected) play('wink')
  }, [shakeTick, connected, play])

  // ── 自主微动作：仅基底可睁眼时（idle / listening） ──
  useIdleBehavior(base === 'idle' || base === 'listening', play)

  const handleTap = useCallback(() => {
    if (!connected) onConnect()
    else onToggleRecording()
  }, [connected, onConnect, onToggleRecording])

  const transform = eyeTransform(base, active, audioLevel)
  const transition = eyeTransition(active)
  // 有些状态不画胶囊眼睛，改由独立符号层表达：
  //   wink → `> <`（挤眼，摇晃触发）；offline → `X X`（掉线）
  const symbol: 'wince' | 'cross' | null =
    active === 'wink' ? 'wince' : base === 'offline' && active !== 'happy' ? 'cross' : null
  const eyeStyleFor = (): CSSProperties => ({
    // 眼睛与其荧光晕共用同一 transform/transition：晕随眼睛尺寸同帧变化，不再脱节
    transform,
    transition,
    transformBox: 'fill-box',
    transformOrigin: 'center',
    opacity: symbol ? 0 : 1,
    // 淡出比形变快：先「消失」再露出符号，避免两个形态叠在一起
    ...(symbol ? { transition: 'opacity 90ms ease-out, transform 240ms ease' } : {}),
  })
  // wink 是 `> <` 挤眼：左右眼各向内倾斜，因此不能共用一份 transform；
  // 头部位移类动作在头组上生效
  const headStyle: CSSProperties =
    active === 'headNod'
      ? {
          transform: 'translateY(10px)',
          transition: 'transform 240ms cubic-bezier(0.34, 1.3, 0.64, 1)',
        }
      : {}
  // 眼睛自身辉光只表达「有生命」的柔光，不随录音音量增强——
  // 收音强度是状态，不该变成亮度。聆听态的变化交给屏幕边框辉光
  const glowOpacity = base === 'idle' || base === 'listening' ? 0.26 : 0.2
  const happy = active === 'happy'
  // AO（环境光/氛围灯）只在聆听时点亮——对齐官方「屏幕四周亮起即表示正在聆听」。
  // 情绪类瞬时动作期间暂时熄灭，避免「嘴在笑、灯还在听」
  const talking = active === 'happy' || active === 'sad'
  const auraVisible = base === 'listening' && !talking

  return (
    <div className="fixed inset-0 z-50 select-none bg-[#050807]">
      {/* SVG 滤镜：荧光晕（feGaussianBlur）——眼睛「配一圈荧光」的来源 */}
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <filter id="evaGlow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="7" />
          </filter>
        </defs>
      </svg>

      {/* 屏幕辉光：不画边框、不做硬描边，光从四边朝屏心连续衰减。
          见 globals.css .eva-glow —— 加任何实心 inset 描边都会在边缘切出硬边 */}
      <div
        aria-hidden="true"
        className={cn(
          'eva-glow pointer-events-none absolute inset-0 transition-opacity duration-700 ease-out',
          auraVisible ? 'opacity-100' : 'opacity-0',
        )}
      />

      {/* 整屏轻触层——Eva 形态唯一的输入面（tap 语义；触屏防滚动同 MicButton：只绑 pointer） */}
      <button
        type="button"
        aria-label={connected ? (recording ? 'Stop recording' : 'Start recording') : 'Reconnect'}
        onPointerDown={handleTap}
        style={{ touchAction: 'none' }}
        className="absolute inset-0 h-full w-full cursor-pointer focus:outline-none"
      />

      {/* 眼睛——纯展示层，不吃事件；外层管扫视（connecting）、内层管呼吸，两层动画互不覆盖 */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <div className={cn(base === 'connecting' && 'eva-search')}>
          <div className="eva-breathe flex items-center" aria-hidden="true">
            <svg
              // 视口必须比眼睛+光晕的**最坏形态**还大：眨眼会 scale(1.625) 把光晕推宽，
              // 若 svg 尺寸卡着眼睛边界，滤镜光晕会被视口硬切出一条直边（实测 x=479 亮、480 断）
              width="760"
              height="520"
              viewBox="0 0 760 520"
              aria-hidden="true"
              style={{ overflow: 'visible' }}
            >
              {/* 头部组（点头等整体位移在此生效） */}
              <g style={headStyle}>
                {(['left', 'right'] as const).map((side) => {
                  const style = eyeStyleFor()
                  const cx = EYE_CX + (side === 'left' ? -EYE_DX : EYE_DX)
                  return (
                    // 荧光晕与眼睛同在一个 g：共用 transform，晕随眼睛尺寸同帧缩放
                    <g key={side} style={style}>
                      {/* 荧光晕分两套，按开心态交叉淡出——晕的尺寸必须跟着形状走，
                          否则月牙里会留一圈胶囊大小的残影：
                            常规态 = 眼睛外扩 GLOW_PAD 的胶囊矩形；
                            开心态 = 月牙外扩 GLOW_PAD（同色描边 GLOW_PAD*2 后再模糊，
                            描边居中扩边界，外侧正好长胖 GLOW_PAD，与胶囊那套等量） */}
                      <rect
                        x={cx - EYE_W / 2 - GLOW_PAD}
                        y={EYE_CY - EYE_H / 2 - GLOW_PAD}
                        width={EYE_W + GLOW_PAD * 2}
                        height={EYE_H + GLOW_PAD * 2}
                        rx={EYE_R + GLOW_PAD}
                        fill={EYE_GREEN}
                        filter="url(#evaGlow)"
                        style={{
                          opacity: happy ? 0 : glowOpacity,
                          transition: 'opacity 200ms ease',
                        }}
                      />
                      <path
                        d={happyPath(cx)}
                        fill={EYE_GREEN}
                        stroke={EYE_GREEN}
                        strokeWidth={GLOW_PAD * 2}
                        filter="url(#evaGlow)"
                        style={{
                          opacity: happy ? glowOpacity : 0,
                          transition: 'opacity 200ms ease',
                        }}
                      />
                      <path
                        d={capsulePath(cx)}
                        fill={EYE_GREEN}
                        style={{
                          opacity: happy ? 0 : 1,
                          transition: 'opacity 160ms ease',
                        }}
                      />
                      {/* 开心：形状换成月牙，与胶囊交叉淡出 */}
                      <path
                        d={happyPath(cx)}
                        fill={EYE_GREEN}
                        style={{
                          opacity: happy ? 1 : 0,
                          transition: 'opacity 200ms ease',
                        }}
                      />
                    </g>
                  )
                })}
                {/* 符号层：`> <` 挤眼 / `X X` 掉线，与眼睛交叉淡出 */}
                <WinceSymbol
                  cx={EYE_CX - EYE_DX}
                  side="left"
                  opacity={symbol === 'wince' ? 1 : 0}
                />
                <WinceSymbol
                  cx={EYE_CX + EYE_DX}
                  side="right"
                  opacity={symbol === 'wince' ? 1 : 0}
                />
                <CrossSymbol
                  cx={EYE_CX - EYE_DX}
                  side="left"
                  opacity={symbol === 'cross' ? 1 : 0}
                />
                <CrossSymbol
                  cx={EYE_CX + EYE_DX}
                  side="right"
                  opacity={symbol === 'cross' ? 1 : 0}
                />
              </g>
            </svg>
          </div>
        </div>
      </div>

      {error && (
        <div className="pointer-events-none absolute inset-x-6 bottom-8 text-center text-xs text-red-400/80">
          {error}
        </div>
      )}
    </div>
  )
}
