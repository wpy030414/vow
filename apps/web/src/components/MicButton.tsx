// MicButton — 录制按钮（Hold/Tap 双模式）

import { useRef, useCallback } from 'react'
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
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isHold = mode === 'hold'

  const handlePointerDown = useCallback(() => {
    if (disabled) return
    if (isHold) {
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

  const handlePointerUp = useCallback(() => {
    if (isHold && recording) {
      onStop()
    }
  }, [isHold, recording, onStop])

  const handlePointerLeave = useCallback(() => {
    if (isHold && recording) {
      onStop()
    }
  }, [isHold, recording, onStop])

  // 音量光环
  const glowScale = 1 + audioLevel * 0.35
  const glowOpacity = 0.25 + audioLevel * 0.5

  return (
    <div className="relative flex items-center justify-center select-none">
      {/* 音量扩散光环 */}
      {recording && (
        <div
          className="absolute inset-0 rounded-full bg-red-400 transition-transform duration-150"
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
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
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
        aria-label={recording ? '停止录音' : '开始录音'}
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
          按住说话
        </span>
      )}
      {mode === 'hold' && recording && (
        <span className="absolute -bottom-9 text-xs text-muted-foreground whitespace-nowrap">
          松开发送
        </span>
      )}
    </div>
  )
}