// OutputToggle — "作为输出设备"开关

import { cn } from '@/lib/utils'
import { Volume2 } from 'lucide-react'

interface OutputToggleProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
  disabled: boolean
}

export function OutputToggle({ enabled, onChange, disabled }: OutputToggleProps) {
  return (
    <label
      className={cn(
        'inline-flex items-center gap-3 px-4 py-3 rounded-lg border',
        'cursor-pointer transition-colors',
        enabled && 'border-accent bg-accent/30',
        !enabled && 'border-border',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <Volume2 className={cn('w-5 h-5', enabled ? 'text-accent-foreground' : 'text-muted-foreground')} />
      <span className={cn('text-sm font-medium', enabled ? 'text-accent-foreground' : 'text-muted-foreground')}>
        作为输出设备
      </span>
      <input
        type="checkbox"
        checked={enabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      {/* 自绘开关 */}
      <div
        className={cn(
          'relative w-9 h-5 rounded-full transition-colors',
          enabled ? 'bg-accent-foreground' : 'bg-muted-foreground/25',
        )}
      >
        <div
          className={cn(
            'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
            enabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </div>
    </label>
  )
}