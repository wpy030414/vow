// ControlBar — Hold/Tap（二选一）+ Listen/转文字（图标复选）融合控制栏

import { cn } from '@/lib/utils'
import type { RecordMode } from '@vow/shared/types'
import { Hand, Pointer, Volume2, Type } from 'lucide-react'

interface ControlBarProps {
  mode: RecordMode
  onModeChange: (mode: RecordMode) => void
  /** 录音中锁定模式切换 */
  modeDisabled: boolean
  outputEnabled: boolean
  onOutputChange: (enabled: boolean) => void
  /** 「转文字」听写联动开关 */
  dictationEnabled: boolean
  onDictationChange: (enabled: boolean) => void
  /** 录音中或非 hold 模式时锁定 */
  dictationDisabled: boolean
}

const modes: { value: RecordMode; label: string; icon: typeof Hand }[] = [
  { value: 'hold', label: 'Hold', icon: Hand },
  { value: 'tap', label: 'Tap', icon: Pointer },
]

const pill = cn(
  // h-9：统一高度——图标按钮无文本行高，若按 py 撑高会比文字按钮矮 4px
  'inline-flex items-center justify-center gap-2 h-9 px-4 rounded-md text-sm font-medium',
  'transition-colors duration-150',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
)

export function ControlBar({ mode, onModeChange, modeDisabled, outputEnabled, onOutputChange, dictationEnabled, onDictationChange, dictationDisabled }: ControlBarProps) {
  return (
    <div className="inline-flex flex-wrap justify-center items-center rounded-lg bg-muted p-1 gap-1">
      <div className="inline-flex gap-1" role="radiogroup" aria-label="录制模式">
        {modes.map((m) => {
          const active = mode === m.value
          return (
            <button
              key={m.value}
              type="button"
              disabled={modeDisabled}
              role="radio"
              aria-checked={active}
              onClick={() => onModeChange(m.value)}
              className={cn(
                pill,
                active && 'bg-background text-foreground shadow-sm',
                !active && !modeDisabled && 'text-muted-foreground hover:text-foreground',
                modeDisabled && 'opacity-40 cursor-not-allowed',
              )}
            >
              <m.icon className="w-4 h-4" />
              <span>{m.label}</span>
            </button>
          )
        })}
      </div>

      {/* 分隔线：左侧二选一（radio），右侧独立复选（checkbox） */}
      <div className="w-px h-6 bg-border mx-1" aria-hidden />

      <button
        type="button"
        role="checkbox"
        aria-checked={outputEnabled}
        aria-label="作为输出设备"
        title="作为输出设备"
        onClick={() => onOutputChange(!outputEnabled)}
        className={cn(
          pill,
          'px-3',
          outputEnabled && 'bg-background shadow-sm text-foreground',
          !outputEnabled && 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Volume2 className={cn('w-4 h-4', outputEnabled && 'text-accent-foreground')} />
      </button>

      <div className="w-px h-6 bg-border mx-1" aria-hidden />

      <button
        type="button"
        role="checkbox"
        aria-checked={dictationEnabled}
        aria-label="语音转文字"
        title={mode === 'hold' ? '语音转文字：按住说话时自动转写并输入' : '语音转文字（仅 Hold 模式可用）'}
        disabled={dictationDisabled}
        onClick={() => onDictationChange(!dictationEnabled)}
        className={cn(
          pill,
          'px-3',
          dictationEnabled && 'bg-background shadow-sm text-foreground',
          !dictationEnabled && !dictationDisabled && 'text-muted-foreground hover:text-foreground',
          dictationDisabled && 'opacity-40 cursor-not-allowed',
        )}
      >
        <Type className="w-4 h-4" />
      </button>
    </div>
  )
}
