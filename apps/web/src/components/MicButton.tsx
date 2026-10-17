// MicButton — 录制按钮（Hold/Tap 双模式）

import { useRef, useCallback } from 'react'
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import { Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RecordMode } from '@vow/shared/types'

interface MicButtonProps {
  mode: RecordMode
  recording: boolean
  audioLevel: number
  disabled: boolean
  onStart: () => void
  onStop: () => void
}

export function MicButton({ mode, recording, audioLevel, disabled, onStart, onStop }: MicButtonProps) {
  const isHold = mode === 'hold'
  // 同步按压标记：不能依赖 recording 状态——startRecording 异步（getUserMedia），
  // 快速点按时 pointerup 先于状态翻转到达，过期闭包会漏掉 stop 导致录音卡死
  const pressingRef = useRef(false)

  const handlePointerDown = useCallback(() => {
    if (disabled) return
    if (isHold) {
      pressingRef.current = true
      onStart()
    } else {
      // Tap 模式：翻转
      if (recording) {
        onStop()
      } else {
        onStart()
      }
    }
  }, [disabled, isHold, recording, onStart, onStop])

  const endPress = useCallback(() => {
    if (isHold && pressingRef.current) {
      pressingRef.current = false
      onStop()
    }
  }, [isHold, onStop])

  // 移动端点击后焦点滞留（focus ring 常显）——blur 必须放在 click 里：
  // click 在浏览器完成焦点赋值之后触发，pointerup 时 blur 会被随后的赋焦覆盖
  const handleClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
  }, [])

  // 音量光环——基础尺寸超出按钮一圈（-inset-3）、振幅区间放大且低电平亦有软光，更醒目
  const glowScale = 1 + audioLevel * 0.5
  const glowOpacity = 0.2 + audioLevel * 0.4

  return (
    <div className="relative flex items-center justify-center select-none">
      {/* 音量扩散光环 */}
      {recording && (
        <div
          className="absolute -inset-3 rounded-full bg-red-400 pointer-events-none transition duration-150"
          style={{
            transform: `scale(${glowScale})`,
            opacity: glowOpacity,
          }}
        />
      )}

      {/* 按钮本体 */}
      <button
        type="button"
        disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerUp={endPress}
        onPointerLeave={endPress}
        onPointerCancel={endPress}
        onClick={handleClick}
        // 触屏防滚动（勿再绑 touch 事件——移动端 pointer+touch 会双触发，
        // 曾导致 startRecording 重入、泄漏的 AudioContext 持续采集）
        style={{ touchAction: 'none' }}
        className={cn(
          // 基础样式
          'relative z-10 w-28 h-28 rounded-full flex items-center justify-center',
          'transition-all duration-200 shadow-lg',
          'focus:outline-none focus-visible:ring-4 focus-visible:ring-ring',
          // 默认态
          !recording && !disabled && 'bg-primary text-primary-foreground hover:scale-105 active:scale-95',
          // 录制态
          recording && 'bg-destructive text-destructive-foreground scale-110',
          // 禁用
          disabled && 'opacity-40 cursor-not-allowed',
        )}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
      >
        {recording ? (
          <MicOff className="w-10 h-10 animate-pulse" />
        ) : (
          <Mic className="w-10 h-10" />
        )}
      </button>

      {/* 模式提示 */}
      {mode === 'hold' && !recording && (
        <span className="absolute -bottom-9 text-xs text-muted-foreground whitespace-nowrap">
          Hold to Talk
        </span>
      )}
      {mode === 'hold' && recording && (
        <span className="absolute -bottom-9 text-xs text-muted-foreground whitespace-nowrap">
          Release to Send
        </span>
      )}
      {mode === 'tap' && !recording && (
        <span className="absolute -bottom-9 text-xs text-muted-foreground whitespace-nowrap">
          Tap to Talk
        </span>
      )}
    </div>
  )
}