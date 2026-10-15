// vow 共享类型定义

/** 音频传输格式 */
export interface AudioChunk {
  /** 客户端生成的唯一 ID */
  id: string
  /** 音频数据（base64 编码） */
  data: string
  /** 采样率 */
  sampleRate: number
  /** 时间戳 */
  timestamp: number
}

/** 录制模式 */
export type RecordMode = 'hold' | 'tap'

/** 设备状态 */
export interface DeviceState {
  connected: boolean
  mode: RecordMode
  recording: boolean
  isOutputEnabled: boolean
}

/** SSE 事件类型 */
export interface SSEMessage {
  type: 'audio' | 'state' | 'error'
  payload: unknown
}