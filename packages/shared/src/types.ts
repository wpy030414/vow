// vow 共享类型定义

// ─── 前端形态 ───

/**
 * 前端产品形态（config.yml 顶层 `mode`）。
 * - codex-micro：默认工具形态（Hold/Tap 双模式、耳返与「转文字」开关齐备）
 * - qwennote-eva：Eva 眼睛桌宠形态——整屏一对随状态变情的眼睛；仅 Tap、
 *   耳返恒关、ASR 恒随录音（服务端强制，见 docs/DECISIONS.md A24）
 */
export type AppMode = 'codex-micro' | 'qwennote-eva'

// ─── 会话 ───

/** 会话连接请求 */
export interface ConnectRequest {
  /** 设备名称（可选） */
  deviceName?: string
  /** 录制模式 */
  mode: RecordMode
}

/** 会话连接响应 */
export interface ConnectResponse {
  sessionId: string
  serverTime: number
  /** 服务端形态（config.yml mode）——前端据此切换 Eva / 工具形态；旧服务端缺省 */
  appMode?: AppMode
}

/** 录制模式 */
export type RecordMode = 'hold' | 'tap'

// ─── 音频 ───

/** 音频数据块（客户端 → 服务端） */
export interface AudioChunk {
  /** 会话 ID */
  sessionId: string
  /** PCM 音频数据（base64 编码） */
  data: string
  /** 采样率 */
  sampleRate: number
  /** 毫秒级时间戳 */
  timestamp: number
  /** 单调递增序列号，用于丢包检测 */
  sequence: number
}

/** 音频上传响应 */
export interface AudioUploadResponse {
  /** 已确认的序列号 */
  received: number
}

// ─── SSE 事件 ───

/** 服务端推送事件 */
export interface ServerEvent {
  type: ServerEventType
  payload?: unknown
  timestamp: number
}

export type ServerEventType = 'connected' | 'heartbeat' | 'peer_state' | 'output_audio' | 'error'

// ─── 设备状态 ───

/** 客户端设备状态 */
export interface DeviceState {
  sessionId: string
  connected: boolean
  mode: RecordMode
  recording: boolean
  isOutputEnabled: boolean
  /** 听写联动是否激活（hold 按下且开启「转文字」） */
  dictation: boolean
  audioLevel: number
}

/** 状态更新请求 */
export interface StateUpdateRequest {
  recording?: boolean
  mode?: RecordMode
  isOutputEnabled?: boolean
  /** 听写联动请求（服务端检测到翻转时注入听写引擎快捷键） */
  dictation?: boolean
  audioLevel?: number
}

// ─── 宿主辅助键 ───

/** 手机端可注入宿主机焦点窗口的辅助键 */
export type HostKey = 'backspace' | 'enter'

/** 辅助键注入请求 */
export interface KeyPressRequest {
  key: HostKey
}

/** 辅助键注入响应 */
export interface KeyPressResponse {
  /** 是否已注入（非 win32 或无 user32 注入能力时 false） */
  ok: boolean
}

// ─── 听写引擎 ───

/**
 * 听写引擎渠道标识。
 * 新增渠道：在此追加成员 + 在 shared/constants 的 DICTATION_ENGINES 中登记 + 在 server 注册表中实现。
 */
export type DictationEngineId = 'iflytek-api'

// ─── 连接信息 ───

/** 服务端连接概览 */
export interface ConnectionInfo {
  connectedCount: number
  sessions: string[]
  /** 当前生效的听写引擎（诊断用）。渠道列表见 shared/constants 的 DICTATION_ENGINES */
  dictationEngine: DictationEngineId
  /** 前端形态（config.yml mode）——前端开机即探，预判 Eva / 工具形态 */
  appMode?: AppMode
}

// ─── 虚拟音频设备 ───

/** VB-Cable 安装状态；'disabled' = 配置中未启用虚拟麦克风（不探测、不告警） */
export type InstallStatus = 'not_installed' | 'installing' | 'installed' | 'failed' | 'disabled'

/** 宿主机音频设备状态 */
export interface AudioDeviceStatus {
  virtualInputAvailable: boolean
  virtualOutputAvailable: boolean
  inputDeviceName: string | null
  outputDeviceName: string | null
  inputActive: boolean
  outputActive: boolean
  /** VB-Cable 安装状态 */
  installStatus: InstallStatus
  /** 安装失败原因（installStatus === 'failed' 时） */
  installError: string | null
}

/** 设备信息 */
export interface DeviceInfo {
  name: string
  type: 'input' | 'output' | 'loopback'
  isVirtual: boolean
  sampleRate: number | null
}

/** 输出捕获控制请求 */
export interface OutputCaptureRequest {
  sessionId: string
  enabled: boolean
}

/** 设备列表响应 */
export interface DeviceListResponse {
  status: AudioDeviceStatus
  devices: DeviceInfo[]
}
