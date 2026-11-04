// useSaccade — 微眼震（micro-saccade）
//
// 人眼在「注视」时并不完全静止：每秒会有几次亚角度级的小跳动（saccade）。
// 完全静止的眼睛会立刻显出"这是张图"，而持续轻微游移会让它在待机时也像活的。
//
// 设计取舍：
// - **随机间隔**而非固定周期：任何规律节奏都会被识别为动画；
// - **亚像素级幅度**：0.6–1.8px，小到不刻意看看不出，但一旦停下就觉得死板；
// - **慢缓动**：220ms ease-out 漂过去，避免瞬移带来的"抽搐"感；
// - 页面不可见时暂停，省电且避免后台一堆定时器。

import { useEffect, useState } from 'react'

export interface SaccadeOffset {
  x: number
  y: number
}

/** 两次微跳的间隔（ms）——下限高于人眼可分辨的闪烁频率，上限避免长时间不动 */
const MIN_GAP_MS = 1500
const MAX_GAP_MS = 4200
/** 单次偏移幅度（px）——必须够小，否则从"微动"变成"乱瞟" */
const MIN_AMP = 0.6
const MAX_AMP = 1.8

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/**
 * @param enabled 为 false 时归零（例如眨眼、情绪动作期间不需要额外噪声）
 */
export function useSaccade(enabled: boolean): SaccadeOffset {
  const [offset, setOffset] = useState<SaccadeOffset>({ x: 0, y: 0 })

  useEffect(() => {
    if (!enabled) {
      setOffset({ x: 0, y: 0 })
      return
    }
    let timer: number | null = null

    const tick = () => {
      const angle = Math.random() * Math.PI * 2
      const amp = rand(MIN_AMP, MAX_AMP)
      setOffset({ x: Math.cos(angle) * amp, y: Math.sin(angle) * amp })
      timer = window.setTimeout(tick, rand(MIN_GAP_MS, MAX_GAP_MS))
    }

    // 首次延迟更长一点：刚进入界面时眼睛先"安定"下来
    timer = window.setTimeout(tick, rand(800, 1800))

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (timer !== null) window.clearTimeout(timer)
        timer = null
      } else if (timer === null) {
        timer = window.setTimeout(tick, rand(400, 1200))
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])

  return offset
}
