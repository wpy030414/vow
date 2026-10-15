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

### 听写联动链路（可选：Hold + 「转文字」）

```
手机按下（hold + 转文字开）→ POST /api/sse/state {dictation:true}
  → SSEHub 翻转检测 → services/dictation 注入快捷键（讯飞 F6 / Win+H）
  → 听写引擎从虚拟麦克风（CABLE）取音 → 转写文本插入当前焦点窗口
  松开/页面关闭/TTL 回收 → 注入停止键或交由引擎静音自动结束
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
| `index.ts` | 入口，挂载路由 + 静态文件 + 音频/听写联动接线 |
| `routes/sse.ts` | SSE 端点管理（连接池、chunk 转发、状态上报） |
| `routes/audio.ts` | 设备列表/状态、输出捕获开关 |
| `services/sse-hub.ts` | 会话池、心跳/TTL 回收、事件广播 |
| `services/virtual-audio.ts` | 虚拟音频设备（VB-CABLE 输入写入 + 环回输出捕获） |
| `services/dictation.ts` | 语音转文字联动——按键注入唤起听写引擎（koffi → keybd_event） |
| `services/tls-cert.ts` | 自签证书生成（HTTPS 安全上下文） |

### apps/web/

| 模块 | 职责 |
|------|------|
| `App.tsx` | 主布局，连接状态与联动状态汇总 |
| `components/MicButton.tsx` | 录制按钮（Hold/Tap 双模式） |
| `components/ControlBar.tsx` | 融合控制栏（Hold/Tap + Listen + 「转文字」开关） |
| `components/VolumeIndicator.tsx` | 实时音量指示 |
| `hooks/useSSE.ts` | SSE 连接管理 hook（含保活 ping） |
| `hooks/useMicrophone.ts` | 麦克风采集 hook（getUserMedia + AudioContext） |
| `hooks/useAudioOutput.ts` | 下行系统音频播放（Web Audio） |