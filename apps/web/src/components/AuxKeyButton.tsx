// AuxKeyButton — 录音键两侧的宿主辅助键（× 删除一个字符 / ✓ 回车）

import { useCallback } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HostKey } from '@vow/shared/types'

interface AuxKeyButtonProps {
  hostKey: HostKey
  /** 录音中禁用（淡化）——避免与听写注入竞争焦点窗口 */
  disabled: boolean
  onPress: (key: HostKey) => void
}

const config: Record<HostKey, { icon: typeof X; label: string }> = {
  backspace: { icon: X, label: 'Delete one character' },
  enter: { icon: Check, label: 'Enter' },
}

export function AuxKeyButton({ hostKey, disabled, onPress }: AuxKeyButtonProps) {
  const { icon: Icon, label } = config[hostKey]

  // 移动端点击后焦点滞留（focus ring 常显）——与 MicButton 同理，blur 必须放在 click 里
  const handleClick = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur()
    onPress(hostKey)
  }, [hostKey, onPress])

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={handleClick}
      className={cn(
        'w-14 h-14 rounded-full flex items-center justify-center select-none',
        'bg-muted text-muted-foreground transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        !disabled && 'hover:bg-accent hover:text-accent-foreground active:scale-95',
        disabled && 'opacity-40 cursor-not-allowed',
      )}
    >
      <Icon className="w-6 h-6" />
    </button>
  )
}
