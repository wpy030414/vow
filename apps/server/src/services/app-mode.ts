// app-mode — qwennote-eva 形态的服务端硬约束（单一策略源，docs/DECISIONS.md A24）
//
// Eva 形态（config.yml mode: qwennote-eva）只保留「说话 → 文字」一条链路：
// 仅 Tap、耳返（输出捕获）恒关、ASR 听写恒随录音态。约束在**服务端**强制——
// 前端只是不渲染对应控件，绕过 UI 直打 API 同样会被拦下。
// codex-micro（默认形态）则全透传，行为与引入本模块之前完全一致。

import type { AppMode, RecordMode, StateUpdateRequest } from '@vow/shared/types'

export interface ModePolicy {
  /** 会话建立时的录制模式：Eva 恒 tap（客户端请求值被忽略） */
  connectMode(requested: RecordMode | undefined): RecordMode
  /**
   * 状态上报整形：Eva 下 mode 恒 tap、isOutputEnabled 恒 false、
   * dictation 恒随录音态（update 未携带 recording 时沿用会话当前值）。
   */
  coerceStateUpdate(update: StateUpdateRequest, currentRecording: boolean): StateUpdateRequest
  /** 是否允许开启输出捕获（耳返）：Eva 恒拒绝 */
  outputEnabledAllowed(): boolean
}

export function createModePolicy(appMode: AppMode): ModePolicy {
  if (appMode === 'qwennote-eva') {
    return {
      connectMode: () => 'tap',
      coerceStateUpdate: (update, currentRecording) => ({
        ...update,
        mode: 'tap',
        isOutputEnabled: false,
        dictation: update.recording ?? currentRecording,
      }),
      outputEnabledAllowed: () => false,
    }
  }
  return {
    connectMode: (requested) => requested ?? 'tap',
    coerceStateUpdate: (update) => update,
    outputEnabledAllowed: () => true,
  }
}
