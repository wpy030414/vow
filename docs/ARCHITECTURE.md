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
手机麦克风 → getUserMedia() → AudioContext → AudioWorklet（128 帧量子累积，1024 采样出块）
  → PCM16 采样 → base64 编码 → POST /api/sse/audio → Hono Server
  → 解码 PCM → 写入虚拟音频输入设备缓冲区 → 系统应用读取
```

### 下行链路（系统音频 → 宿主 → 手机）

```
系统音频输出 → 虚拟音频输出设备缓冲区 → Hono Server
  → SSE push → 手机 Web Audio API → AudioContext
  → 输出路由（iOS: navigator.audioSession / Android: setSinkId）→ 手机扬声器
```

> 输出路由见 A18：移动端一旦用过麦克风，系统音频会话会被切入录放类别而把外放锁到「听筒」，
> 故下行播放需显式声明扬声器路由。

### 听写联动链路（可选：Hold + 「转文字」）

```
手机按下（hold + 转文字开）→ POST /api/sse/state {dictation:true}
  → SSEHub 翻转检测 → 默认 iflytek-api（凭据 base64 内置）：开 ASR 会话（PCM 经 16k 重采样 + 80ms 分帧直连讯飞 WS）
                      VOW_DICTATION_ENGINE=win-dictation 才注入 Win+H（经虚拟麦克风回流的保底路径）
  → 转写结果不下发手机端（仅宿主机控制台日志）
  松开 → ASR 尾帧 status:2 收尾 → 终稿 SendInput（Unicode 注入）打入焦点窗口
  页面关闭/TTL 回收/服务停止 → 强制释放
```

### 辅助键链路（手机 → 宿主焦点窗口）

```
手机点按 ×（退格）/ ✓（回车）→ POST /api/keys/press {key:'backspace'|'enter'}
  → koffi → user32 keybd_event 注入焦点窗口
  录音中前端禁用（淡化）——避免与听写收尾的 SendInput 文本注入竞争焦点窗口
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
| `index.ts` | 入口，挂载路由 + 鉴权中间件 + 静态文件 + 音频/听写联动接线 |
| `routes/sse.ts` | SSE 端点管理（连接池、chunk 转发、状态上报） |
| `routes/audio.ts` | 设备列表/状态、输出捕获开关 |
| `routes/keys.ts` | 宿主辅助键注入（POST /api/keys/press：退格 / 回车，白名单校验） |
| `routes/pair.ts` | 配对路由——POST /api/pair 以令牌换 HttpOnly cookie（注册于鉴权中间件之前） |
| `services/auth.ts` | 配对令牌持久化（.vow/pairing-token）+ Auth 中间件（cookie/Bearer，常量时间比对） |
| `services/pairing-qr.ts` | 终端配对二维码打印（qrcode-terminal 动态加载，缺失降级纯链接） |
| `services/sse-hub.ts` | 会话池、心跳/TTL 回收、事件广播 |
| `services/virtual-audio.ts` | 虚拟音频设备（输入写入 = @vow/portaudio(koffi→PortAudio, worker 线程)；环回输出捕获） |
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
| `components/AuxKeyButton.tsx` | 录音键两侧辅助键（× 退格 / ✓ 回车，录音中禁用淡化） |
| `components/ControlBar.tsx` | 融合控制栏（Hold/Tap + Listen + 「转文字」开关） |
| `components/VolumeIndicator.tsx` | 实时音量指示 |
| `hooks/useSSE.ts` | SSE 连接管理 hook（含保活 ping） |
| `hooks/useMicrophone.ts` | 麦克风采集 hook（getUserMedia + AudioWorklet，1024 采样块） |
| `worklets/mic-capture-worklet.js` | AudioWorklet 采集处理器（128 帧量子累积 → 1024 采样 transfer 出块；纯 JS，?url 外链） |
| `hooks/useAudioOutput.ts` | 下行系统音频播放（Web Audio） |

### packages/portaudio/（@vow/portaudio）

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 主线程侧 API：两级 createRequire 资源定位、worker 桥（超时/崩溃自动重启/优雅关闭）、输出流对象 |
| `src/worker-source.ts` | eval/CJS worker 源码字符串：koffi 声明与全部 Pa_* 调用（独占线程） |
| `src/types.ts` | 公开 API 与 worker 协议类型（协议测试守护同步） |
| `bin/portaudio_x64.dll` | 自持 PortAudio（WASAPI x64，V19.7.0-devel），与 `LICENSE-PortAudio.txt` 同源注记 |