// ModeSelector — Hold / Tap 模式切换

import { cn } from '@/lib/utils'
import type { RecordMode } from '@vow/shared/types'
import { Hand, ToggleLeft } from 'lucide-react'

interface ModeSelectorProps {
  mode: RecordMode
  onChange: (mode: RecordMode) => void
  disabled: boolean
}

const modes: { value: RecordMode; label: string; icon: typeof Hand; description: string }[] = [
  { value: 'hold', label: 'Hold', icon: Hand, description: '按住说话' },
  { value: 'tap', label: 'Tap', icon: ToggleLeft, description: '点击切换' },
]

export function ModeSelector({ mode, onChange, disabled }: ModeSelectorProps) {
  return (
    <div className="inline-flex rounded-lg bg-muted p-1 gap-1" role="radiogroup" aria-label="录制模式">
      {modes.map((m) => {
        const active = mode === m.value
        return (
          <button
            key={m.value}
            type="button"
            disabled={disabled}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(m.value)}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium',
              'transition-colors duration-150',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active && 'bg-background text-foreground shadow-sm',
              !active && !disabled && 'text-muted-foreground hover:text-foreground',
              disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            <m.icon className="w-4 h-4" />
            <span>{m.label}</span>
          </button>
        )
      })}
    </div>
  )
}