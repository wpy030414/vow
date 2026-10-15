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
  → SSEHub 翻转检测 → 默认 iflytek-api（凭据 base64 内置）：开 ASR 会话（PCM 经 16k 重采样 + 80ms 分帧直连讯飞 WS）
                      VOW_DICTATION_ENGINE=win-dictation 才注入 Win+H（经虚拟麦克风回流的保底路径）
  → 转写结果不下发手机端（仅宿主机控制台日志）
  松开 → ASR 尾帧 status:2 收尾 → 终稿 SendInput（Unicode 注入）打入焦点窗口
  页面关闭/TTL 回收/服务停止 → 强制释放
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
| `services/dictation.ts` | 语音转文字联动——Win+H 引擎（按键注入 + 翻转去重；env 显式启用） |
| `services/win32-keys.ts` | 原生按键注入底层（koffi → user32 keybd_event，dictation/typing 共用） |
| `services/typing.ts` | 转写文本注入——KEYEVENTF_UNICODE 逐码元打入焦点窗口（绕过输入法） |
| `services/iflytek-asr.ts` | 讯飞私有 ASR 直连（签名/重采样/分帧/WS 会话/听写门面，协议见 scripts/recon/FINDINGS.md） |
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