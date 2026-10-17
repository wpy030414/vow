// PairingScreen — 未配对引导：宿主机终端 pnpm pair 扫码完成配对

import { QrCode, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PairingScreenProps {
  /** ?t= 配对尝试失败时的错误提示（null = 未尝试过） */
  error: string | null
  /** 重新连接（例如已在其他标签页完成配对后的入口） */
  onRetry: () => void
}

export function PairingScreen({ error, onRetry }: PairingScreenProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6 w-full max-w-sm px-6">
        <div className="text-center select-none">
          <h1 className="text-3xl font-bold tracking-tight">vow</h1>
          <p className="text-sm text-muted-foreground mt-1">Voice over Web</p>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <QrCode className="w-4 h-4" />
          <span>This device is not paired yet</span>
        </div>

        <div className="text-sm text-muted-foreground text-center leading-6 bg-muted/50 rounded-lg px-4 py-3 w-full">
          1. Run <code className="font-mono text-foreground">pnpm pair</code> in the host terminal
          <br />
          2. Scan the QR code shown in the terminal (or open its link on this phone)
          <br />
          3. Already scanned and still here? Tap the button below to retry
        </div>

        {error && (
          <div className="text-xs text-destructive text-center bg-destructive/10 rounded-lg px-4 py-2 w-full">
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'inline-flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-colors',
            'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          <RefreshCw className="w-4 h-4" />
          Reconnect
        </button>
      </div>
    </div>
  )
}
