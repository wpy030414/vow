# ARCHITECTURE — vow

## 系统架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         宿主机 (Host)                             │
│                                                                  │
│  ┌──────────┐  SSE/HTTP    ┌──────────────┐   PCM Buffer   ┌────┐│
│  │  手机浏览器│◄────────────►│ Hono Server  │◄──────────────►│虚拟││
│  │          │              │ :48085       │                │音频││
│  │ Web Mic  │              │              │                │设备││
│  │   App    │              │ /api/sse     │                │    ││
│  └──────────┘              └──────────────┘                └────┘│
│       ▲                         │                               │
│       │                         ▼                               │
│  User Mic    ┌──────────────────────────────────────┐            │
│  (getUserMedia)│         Desktop Apps              │            │
│              │  Zoom / OBS / Discord / DAW         │            │
│              └──────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────┘
```

## 数据流

### 上行链路（手机 → 宿主 → 系统应用）

```
手机麦克风 → getUserMedia() → AudioContext → ScriptProcessor/AudioWorklet
  → PCM 采样 → base64 编码 → SSE POST → Hono Server
  → 解码 PCM → 写入虚拟音频输入设备缓冲区 → 系统应用读取
```

### 下行链路（系统音频 → 宿主 → 手机）

```
系统音频输出 → 虚拟音频输出设备缓冲区 → Hono Server
  → SSE push → 手机 Web Audio API → AudioContext → 手机扬声器
```

## 技术决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | SSE 而非 WebSocket | 手机→宿主单向为主，SSE 更简单、自动重连、HTTP/2 友好 |
| D2 | PCM 而非 Opus/压缩 | 降低延迟、避免编解码开销；PCM 直接写入虚拟设备 |
| D3 | 双 SSE 通道 | 上行：客户端 POST audio chunk；下行：服务端 SSE push 系统音频 |
| D4 | 虚拟音频设备用平台原生 API | Windows WASAPI、macOS CoreAudio、Linux PulseAudio/ALSA |
| D5 | 先用 node-speaker 做输出 | 成熟稳定，后续可演进为原生绑定 |

## 模块职责

### apps/server/

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口，挂载路由 + 静态文件 |
| `routes/sse.ts` | SSE 端点管理（连接池、chunk 转发） |
| `services/audio-input.ts` | 虚拟音频输入设备管理 |
| `services/audio-output.ts` | 虚拟音频输出设备管理 |
| `services/device-manager.ts` | 设备注册/注销、连接状态管理 |

### apps/web/

| 模块 | 职责 |
|------|------|
| `App.tsx` | 主布局，连接状态上下文 |
| `components/MicButton.tsx` | 录制按钮（Hold/Tap 双模式） |
| `components/ModeSelector.tsx` | Hold/Tap 模式切换 |
| `components/OutputToggle.tsx` | "作为输出设备"开关 |
| `components/ConnectionStatus.tsx` | 连接状态指示 |
| `hooks/useSSE.ts` | SSE 连接管理 hook |
| `hooks/useMicrophone.ts` | 麦克风采集 hook（getUserMedia + AudioContext） |