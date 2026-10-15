// vow 共享类型定义

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

export type ServerEventType =
  | 'connected'
  | 'heartbeat'
  | 'peer_state'
  | 'output_audio'
  | 'error'

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

// ─── 连接信息 ───

/** 服务端连接概览 */
export interface ConnectionInfo {
  connectedCount: number
  sessions: string[]
  /** 当前生效的听写引擎（诊断用；默认 iflytek-api，env 注入 VOW_DICTATION_ENGINE=win-dictation 切换） */
  dictationEngine: 'iflytek-api' | 'win-dictation'
}

// ─── 虚拟音频设备 ───

/** VB-Cable 安装状态 */
export type InstallStatus = 'not_installed' | 'installing' | 'installed' | 'failed'

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