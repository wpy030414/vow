// VolumeIndicator — 实时音量条

import { cn } from '@/lib/utils'

interface VolumeIndicatorProps {
  level: number
  recording: boolean
}

/** 0-1 归一化电平 → 分段 0-5 条 */
function levelToBars(level: number): number {
  if (level <= 0) return 0
  if (level < 0.08) return 1
  if (level < 0.2) return 2
  if (level < 0.4) return 3
  if (level < 0.65) return 4
  return 5
}

export function VolumeIndicator({ level, recording }: VolumeIndicatorProps) {
  const bars = recording ? levelToBars(level) : 0

  return (
    <div className="flex items-end gap-1 h-8" aria-label={`音量：${Math.round(level * 100)}%`}>
      {Array.from({ length: 5 }, (_, i) => {
        const active = i < bars
        return (
          <div
            key={i}
            className={cn(
              'w-2 rounded-sm transition-all duration-100',
              active ? 'bg-green-500' : 'bg-muted-foreground/25',
            )}
            style={{ height: `${12 + (i + 1) * 4}px` }}
          />
        )
      })}
    </div>
  )
}