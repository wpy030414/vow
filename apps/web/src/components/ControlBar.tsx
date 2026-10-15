// ControlBar — Hold/Tap（二选一）+ 「作为输出设备」（独立复选）融合控制栏

import { cn } from '@/lib/utils'
import type { RecordMode } from '@vow/shared/types'
import { Hand, ToggleLeft, Volume2 } from 'lucide-react'

interface ControlBarProps {
  mode: RecordMode
  onModeChange: (mode: RecordMode) => void
  /** 录音中锁定模式切换 */
  modeDisabled: boolean
  outputEnabled: boolean
  onOutputChange: (enabled: boolean) => void
}

const modes: { value: RecordMode; label: string; icon: typeof Hand }[] = [
  { value: 'hold', label: 'Hold', icon: Hand },
  { value: 'tap', label: 'Tap', icon: ToggleLeft },
]

const pill = cn(
  'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium',
  'transition-colors duration-150',
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
)

export function ControlBar({ mode, onModeChange, modeDisabled, outputEnabled, onOutputChange }: ControlBarProps) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-1 gap-1">
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
        onClick={() => onOutputChange(!outputEnabled)}
        className={cn(
          pill,
          outputEnabled && 'bg-background shadow-sm text-foreground',
          !outputEnabled && 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Volume2 className={cn('w-4 h-4', outputEnabled && 'text-accent-foreground')} />
        <span>Listen</span>
      </button>
    </div>
  )
}
