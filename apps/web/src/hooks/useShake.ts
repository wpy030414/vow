// useShake — 移动端摇晃检测（DeviceMotion）
//
// 用于 Eva 形态的「`> <` 挤眼」：主人晃一下手机，眼睛就挤一下。
//
// 浏览器/iOS 约束（踩过的坑都在这里）：
// - `devicemotion` 只在**安全上下文**下派发；本项目 dev 与 prod 都是 HTTPS，满足；
// - iOS 13+ 必须有**用户手势内同步调用** `DeviceMotionEvent.requestPermission()` 授权；
// - 授权是**粘性**的，但一旦被拒，再次调用会直接返回 denied——因此不能一次性
//   `armedRef` 锁死，要允许用户在下次轻触时重试（失败时不置位）；
// - iOS 上 `event.acceleration` 常常给 null，只有 `accelerationIncludingGravity`
//   有值——必须做回退，否则整条链路静默失效；
// - iOS Safari 默认不开传感器，还需系统「设置 → Safari → 运动与方向访问」打开。
//
// 判定口径：优先用去掉重力的 acceleration 做差分；拿不到时用含重力加速度**去均值**
// 后再差分——重力恒定分量会被抵消，剩下的抖动才是「摇晃」。

import { useCallback, useEffect, useRef } from 'react'

/** 触发阈值（Δ m/s²）。iOS 的实现里差分幅值偏小，取 12 兼顾灵敏度与误触 */
const SHAKE_THRESHOLD = 12
/** 两次触发的最小间隔（ms）：挤眼动作本身 900ms，留一点余量避免连发 */
const SHAKE_COOLDOWN_MS = 1100
/** 含重力样本的滑动均值窗口——用于抵消重力常量 */
const GRAVITY_WINDOW = 10

/** iOS 13+ 的权限申请接口（TS 标准库未收录） */
type MotionPermissionCtor = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}

export type ShakeStatus = 'idle' | 'unsupported' | 'requesting' | 'granted' | 'denied' | 'silent'

export interface ShakeState {
  /** 由用户手势**同步**调用：申请传感器权限并开始监听（与麦克风授权同处一次手势） */
  arm: () => void
}

/**
 * @param onShake 检测到摇晃时回调（内部用 ref 持有最新值，无需保持稳定）
 * @param enabled 为 false 时不触发（例如掉线）
 */
export function useShake(onShake: () => void, enabled: boolean): ShakeState {
  const handlerRef = useRef(onShake)
  handlerRef.current = onShake
  const statusRef = useRef<ShakeStatus>('idle')

  const setStatus = useCallback((s: ShakeStatus) => {
    statusRef.current = s
  }, [])

  /** 是否已挂上监听（挂上后不再重复挂） */
  const listeningRef = useRef(false)
  /** 授权进行中——防止同一手势内重复请求 */
  const pendingRef = useRef(false)
  /** 上一帧加速度向量与上次触发时间 */
  const lastRef = useRef<{ x: number; y: number; z: number } | null>(null)
  /** 含重力样本的滑动均值（抵消重力） */
  const gravityRef = useRef({ x: 0, y: 0, z: 0, n: 0 })
  const lastFiredRef = useRef(0)
  /** 是否启用（掉线等场景关闭）——用 ref 让监听器读到最新值，避免重绑事件 */
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  const startListening = useCallback(() => {
    if (listeningRef.current) return
    if (typeof window === 'undefined' || !window.DeviceMotionEvent) {
      setStatus('unsupported')
      return
    }
    listeningRef.current = true
    setStatus('granted')

    // 授权后若长时间收不到事件，多半是系统级传感器开关被关（iOS「运动与方向访问」）
    const watchdog = window.setTimeout(() => {
      if (statusRef.current === 'granted') setStatus('silent')
    }, 2500)

    window.addEventListener(
      'devicemotion',
      (e: DeviceMotionEvent) => {
        window.clearTimeout(watchdog)
        if (statusRef.current === 'silent') setStatus('granted')

        const clean = e.acceleration
        const withG = e.accelerationIncludingGravity
        let ax: number, ay: number, az: number

        if (clean && clean.x != null && clean.y != null && clean.z != null) {
          ax = clean.x
          ay = clean.y
          az = clean.z
        } else if (withG && withG.x != null && withG.y != null && withG.z != null) {
          // 含重力：先累积均值估计重力方向，再减去它得到线性加速度
          const g = gravityRef.current
          g.n = Math.min(g.n + 1, GRAVITY_WINDOW)
          const k = 1 / g.n
          g.x += (withG.x - g.x) * k
          g.y += (withG.y - g.y) * k
          g.z += (withG.z - g.z) * k
          ax = withG.x - g.x
          ay = withG.y - g.y
          az = withG.z - g.z
        } else {
          return
        }

        const prev = lastRef.current
        lastRef.current = { x: ax, y: ay, z: az }
        if (!prev) return

        const dx = ax - prev.x
        const dy = ay - prev.y
        const dz = az - prev.z
        const delta = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (!enabledRef.current) return
        if (delta < SHAKE_THRESHOLD) return
        const now = Date.now()
        if (now - lastFiredRef.current < SHAKE_COOLDOWN_MS) return
        lastFiredRef.current = now
        handlerRef.current()
      },
      { passive: true },
    )
  }, [setStatus])

  const arm = useCallback(() => {
    if (listeningRef.current || pendingRef.current) return
    if (typeof window === 'undefined' || !window.DeviceMotionEvent) {
      setStatus('unsupported')
      return
    }
    const ctor = window.DeviceMotionEvent as MotionPermissionCtor

    // 非 iOS / 无权限模型：直接开始监听
    if (typeof ctor.requestPermission !== 'function') {
      startListening()
      return
    }

    // iOS：必须在用户手势内**同步**调用。失败不锁死，允许下次轻触重试
    pendingRef.current = true
    setStatus('requesting')
    const timer = window.setTimeout(() => {
      pendingRef.current = false
    }, 4000)

    ctor.requestPermission().then(
      (state) => {
        window.clearTimeout(timer)
        pendingRef.current = false
        if (state === 'granted') startListening()
        else setStatus('denied')
      },
      () => {
        window.clearTimeout(timer)
        pendingRef.current = false
        // 非手势上下文或用户拒绝——标记后允许重试
        setStatus('denied')
      },
    )
  }, [startListening, setStatus])

  // 掉线时清空基准，恢复后不会用过期向量算出一个假的大位移
  useEffect(() => {
    if (!enabled) {
      lastRef.current = null
      gravityRef.current = { x: 0, y: 0, z: 0, n: 0 }
    }
  }, [enabled])

  return { arm }
}
