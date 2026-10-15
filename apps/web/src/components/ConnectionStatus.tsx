// ConnectionStatus — 连接状态兼录制模式显示

import { cn } from '@/lib/utils'
import { Wifi, WifiOff, Radio, Info } from 'lucide-react'
import type { RecordMode } from '@vow/shared/types'

interface ConnectionStatusProps {
  connected: boolean
  connecting: boolean
  sessionId: string | null
  recording: boolean
  mode: RecordMode
  isOutputEnabled: boolean
  connectedCount?: number
}

export function ConnectionStatus({
  connected, connecting, sessionId, recording, mode, isOutputEnabled, connectedCount,
}: ConnectionStatusProps) {
  const statusText = connecting
    ? '连接中...'
    : connected
      ? recording
        ? '录制中'
        : '已连接'
      : '未连接'

  const statusColor = connecting
    ? 'text-yellow-500'
    : connected
      ? recording
        ? 'text-red-500'
        : 'text-green-500'
      : 'text-muted-foreground'

  return (
    <div className="flex flex-col gap-2 text-sm">
      {/* 连接状态行 */}
      <div className="flex items-center gap-2">
        {connected ? (
          <Wifi className={cn('w-4 h-4', statusColor)} />
        ) : (
          <WifiOff className="w-4 h-4 text-muted-foreground" />
        )}
        <span className={cn('font-medium', statusColor)}>{statusText}</span>
        {mode === 'hold' && !recording && connected && (
          <span className="text-muted-foreground text-xs">· Hold 模式</span>
        )}
        {isOutputEnabled && (
          <span className="text-xs bg-accent text-accent-foreground px-1.5 py-0.5 rounded">
            🔊 输出
          </span>
        )}
      </div>

      {/* 元数据 */}
      {sessionId && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Info className="w-3 h-3" />
          <span className="font-mono">{sessionId.slice(0, 16)}…</span>
          {connectedCount !== undefined && connectedCount > 1 && (
            <span>· {connectedCount} 设备在线</span>
          )}
        </div>
      )}
    </div>
  )
}