// vow 共享常量

/** 默认服务端口 */
export const DEFAULT_PORT = 48085

/** API 路由前缀 */
export const API_PREFIX = '/api'

// ─── SSE ───

/** SSE 流端点 */
export const SSE_STREAM_PATH = '/api/sse/stream'

/** 会话管理端点 */
export const SSE_SESSION_PATH = '/api/sse/session'

/** 音频上传端点 */
export const SSE_AUDIO_PATH = '/api/sse/audio'

/** 状态更新端点 */
export const SSE_STATE_PATH = '/api/sse/state'

/** 连接信息端点 */
export const SSE_INFO_PATH = '/api/sse/info'

// ─── 音频参数 ───

/** 默认采样率 */
export const DEFAULT_SAMPLE_RATE = 44100

/** 系统音频环回采样率（loopback-capture 在 Windows 上固定输出 48kHz / 16bit / stereo） */
export const LOOPBACK_SAMPLE_RATE = 48000

/** 系统音频环回声道数 */
export const LOOPBACK_CHANNELS = 2

/** ScriptProcessor 缓冲区大小（4096 / 44100 ≈ 93ms） */
export const AUDIO_BUFFER_SIZE = 4096

/** 声道数 */
export const AUDIO_CHANNELS = 1

// ─── 连接参数 ───

/** SSE 心跳间隔（毫秒） */
export const SSE_HEARTBEAT_MS = 15_000

/** 客户端保活 ping 间隔（毫秒） */
export const SSE_PING_MS = 15_000

/** 会话空闲超时（毫秒）——超过即回收；90s 容忍后台标签页定时器节流（最长 60s 一次） */
export const SSE_SESSION_TTL_MS = 90_000

/** EventSource 重连等待（毫秒） */
export const SSE_RECONNECT_MS = 3_000

// ─── 音频 API ───

/** 音频设备管理端点 */
export const AUDIO_DEVICES_PATH = '/api/audio/devices'

/** 输出捕获控制端点 */
export const AUDIO_OUTPUT_PATH = '/api/audio/output'

// ─── 虚拟音频参数 ───

/** 输入环形缓冲大小（样本数，200ms @ 44100Hz） */
export const INPUT_RING_BUFFER_SAMPLES = 8820

/** 输出块大小（PortAudio 写入块） */
export const OUTPUT_CHUNK_SAMPLES = 1024

/** VB-Cable 设备名关键词 */
export const VB_CABLE_KEYWORD = 'CABLE'

/** VB-Cable 驱动包下载地址 */
export const VB_CABLE_DOWNLOAD_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'

/** 安装后等待设备出现的超时（毫秒） */
export const VB_CABLE_INSTALL_TIMEOUT_MS = 30_000