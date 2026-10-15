# DECISIONS — vow

## 架构决策记录

### A1：pnpm workspace，无外部编排

**决策**：使用 pnpm 原生 workspace 协议 + concurrently 编排脚本。
**理由**：项目规模无需 Turborepo/Nx；workspace:* 协议足够管理内部依赖。

### A2：shared 包零构建，TS 源码直引

**决策**：`@vow/shared` 通过 `exports → ./src/*.ts` 直接导出 TypeScript 源码，由 tsup `noExternal` 内联到 server bundle。
**理由**：shared 包体量小，无需单独构建步骤；Vite 原生支持 TS，tsup 内联确保 server dist/ 自包含。

### A3：tsup ESM + noExternal shared

**决策**：server 用 tsup 打包 ESM 格式，`noExternal: ['@vow/shared']`。
**理由**：ESM 是 Node.js 未来方向；内联 shared 避免生产部署时的路径解析问题。

### A4：Vite outDir → apps/server/dist/client/

**决策**：前端构建产物直接输出到 server 的 dist/client/ 目录。
**理由**：单进程部署，Hono 在生产模式直接托管静态文件。

### A5：开发模式 Vite proxy /api → Hono

**决策**：Vite dev server 将 `/api` 请求代理到 Hono :48085。
**理由**：避免 CORS 问题；前后端独立热重载。

### A6：SSE 而非 WebSocket

**决策**：使用 SSE 作为实时通信协议。
**理由**：
- 音频上行是单向的（手机→宿主），SSE POST 足够
- 下行系统音频也是单向（宿主→手机），SSE EventSource 原生支持自动重连
- HTTP 协议无额外握手开销，天然兼容代理/LB
- 无需引入 Socket.IO 等额外依赖

### A7：PCM 原始格式传输

**决策**：音频以 PCM 格式传输，不做 Opus/Vorbis 等压缩。
**理由**：降低端到端延迟；手机端 Web Audio 原生输出 PCM；虚拟设备直接写入 PCM buffer。

### A8：shadcn/ui 组件模式

**决策**：使用 Radix + Tailwind + CVA + CSS 变量 构建 UI。
**理由**：组件所有权在项目内，可完全定制；可访问性由 Radix 保证；暗色模式天然支持。

### A9：Hono 4 后端框架

**决策**：使用 Hono 而非 Express/Fastify。
**理由**：轻量、TypeScript-first、标准 Web API、兼容任何 Node/http 部署。

### A10：跨平台虚拟音频策略

**决策**：分平台实现虚拟音频设备。

| 平台 | 方案 | 依赖 |
|------|------|------|
| Windows | WASAPI 虚拟设备 | `audioworklet` 或 portaudio 绑定 |
| macOS | CoreAudio Aggregate Device | 命令行工具配置 |
| Linux | PulseAudio module-null-sink | `pactl` 命令 |

**MVP 阶段**：优先实现 Linux PulseAudio 方案（开发环境），Windows 通过 WASAPI 或第三方虚拟音频驱动实现。

### A11：语音转文字双引擎——iflytek-api 私有协议直连（默认）+ Win+H 保底

**决策**：hold + 「转文字」触发听写。默认 `iflytek-api`：服务端直连讯飞私有 ASR（签名握手 + raw PCM16@16k WS 推流），终稿经 SendInput（KEYEVENTF_UNICODE）打入焦点窗口；凭据（apiKey/apiSecret/appId）以 base64 集成于源码，开箱即用、env 可逐字段覆盖；注入 `VOW_DICTATION_ENGINE=win-dictation` 才切换到 `win-dictation`（koffi → keybd_event 注入 Win+H，toggle 语义）。
**理由**：
- Claude Code 原生 voice 模式为纯云端转写 + claude.ai OAuth 三重 gate（本机代理环境不可用），排除
- 讯飞输入法快捷键注入路线实测失败（F6 未唤起面板）且重度依赖输入法客户端（须安装/运行/焦点/快捷键配置），被判定不可接受，放弃
- 私有协议经 frida 完整逆向并以真实会话回放验证（scripts/recon/FINDINGS.md，含签名 golden 向量）；实测端点接受 raw PCM 直发，免 opus 编码器；运行时零讯飞组件依赖
**代价**：私有协议存在被服务端升级破坏的风险（用户已知悉并接受；Win+H 保底一行 env 可切回）；凭据为设备级，仅供本机个人使用。

### A12：koffi FFI + 自持 PortAudio DLL 替换 naudiodon（安装链零编译）

**决策**：虚拟麦克风链路（VB-Cable 写入）由 `@gpeng/naudiodon`（NAN 原生绑定，安装期 node-gyp 现场编译）迁移为自研 workspace 包 `@vow/portaudio`——koffi FFI（Node-API 预编译二进制随 npm 包分发）直连自持的 `portaudio_x64.dll`（PortAudio V19.7.0-devel，MIT，随仓库分发），全部 Pa_* 调用运行在独立 worker_threads 中；同时撤销此前的 pnpm patch 临时修复（commit 3eb4a6e）并移除 naudiodon 依赖。回归手段：`pnpm portaudio-check`（枚举 + 正弦写入冒烟）。
**理由**：
- Node 26 官方构建内置 `enable_thin_lto/lto_jobs` 变量，node-gyp <13 将其泄漏进 MSVC 工程（LNK1117），且 naudiodon 属 NAN 老式 ABI——**每台新机器、每次 Node 大版本升级都会复发**（上游修复：node-gyp 13.0.0 / PR #3331，但 pnpm/npm 当时仍捆绑 12.4.0）
- koffi 为 Node-API 预编译、DLL 与 Node ABI 零耦合 → 永久免编译、免 VS2022/Python 前提；全新机器 `pnpm install` 实测 3.6s，与 Node 版本解耦
- 与既有 `win32-keys.ts`（koffi → user32）同构，仓库统一 FFI 技术栈；FFI 声明经真实探针验证（枚举 40 设备 / 开流 / 阻塞写全 0 错误）
- 阻塞式 `Pa_WriteStream` 放独立 worker（PaStream 有线程亲和性，不可用 koffi.async），主事件循环零阻塞；完整复刻 naudiodon 的「无流时新鲜枚举」（漂移重试的前提）、`defaultLowOutputLatency` 与 closeOnError 语义
**代价**：自持 603KB 二进制（升级 PortAudio 须重跑 portaudio-check 并复核 `worker-source.ts` 结构体布局）；FFI 声明面改为自维护（协议测试 + 冒烟脚本 + 本记录三道防线）；worker 引入 eval 字符串层（协议类型集中于 `types.ts`，替身桥测试守护）。

### A13：配对令牌鉴权——二维码换取 HttpOnly cookie（/api 全量收口）

**决策**：所有 `/api/*`（`/api/pair`、`/api/health` 除外）需配对鉴权：宿主端首次生成 128-bit 随机令牌持久于 `.vow/pairing-token`（gitignored，重启/热重载不换码）；`pnpm pair`（或生产形态启动）在终端打印二维码（URL 携带 `?t=`），手机扫码后由 SPA 调 `POST /api/pair` 换取 `vow_token` cookie（HttpOnly + Secure + SameSite=Strict，180 天；浏览器对同源 fetch/EventSource 自动携带——客户端网络层零改动）；中间件另接受 `Authorization: Bearer`（CLI 冒烟通道）。令牌可反复出示（多设备同扫一码）；轮换 = `pnpm pair --rotate`（旧 cookie 立即全部失效）。同批收口：移除全开 `cors()`、`sessionId` 改 `crypto.randomUUID()`。
**理由**：
- 威胁模型是「同一 WiFi 内的任何人 + 手机随手打开的恶意网页」：此前无鉴权可建会话后直接窃听系统音频回环（loopback→SSE）、经 ASR+SendInput 向宿主焦点窗口注入文本、向虚拟麦克风灌音；`cors()` 的 `ACAO:*` 让任意网页可读写 API（浏览器 drive-by）
- LAN IP 白名单无效（威胁者天然在网段内）；原生 EventSource 无法自定义 header → cookie 是唯一「客户端网络层零改动」的凭据载体；fetch 手写 SSE 则须重新实现自动重连与心跳联动，不划算
- 秘密的本质是物理接近：二维码只在宿主终端显示；tsx watch 频繁重启要求令牌必须持久化（per-run 令牌会逼人每次热重载重扫）
**代价**：cookie 按 origin（scheme+IP+port）存取——宿主 IP 变更（建议 DHCP 保留）或 dev/prod 端口切换需重新扫码；`?t=` 配对的瞬间令牌出现在地址栏（前端随即 `replaceState` 抹除）；ASR 凭据内嵌与自签证书「继续访问」点击为既有决策，不受本项影响。

### A14：麦克风采集迁移 AudioWorklet——1024 采样块（上行量化延迟 93ms → 23ms）

**决策**：手机端采集由 `ScriptProcessorNode`（4096 采样块 ≈ 93ms，回调在主线程，已废弃）迁移为 `AudioWorkletNode('mic-capture')`——worklet 按 128 帧渲染量子累积，每满 1024 采样（≈23ms）经 transfer 零拷贝出一块；主线程仅剩 PCM16 编码与上行 POST。采集块常量 `AUDIO_BUFFER_SIZE` → `CAPTURE_CHUNK_SAMPLES = 1024`。worklet 源码以纯 JS 独立文件维护（`apps/web/src/worklets/mic-capture-worklet.js`），经 `?url&no-inline` 由 Vite 托管为外链资产。
**理由**：
- 4096 采样量化 ≈ 93ms 是上行可控链路延迟主项（≈136ms → ≈66ms，近半）；服务端环形缓冲与 23ms 节拍本以 1024 为粒度，两侧对齐后稳态缓冲占用同步降低
- ScriptProcessor 已废弃：音频回调在主线程，渲染长任务/GC 直接串进采集节奏；worklet 独立线程免疫
- 纯 JS + 强制外链是有意为之：AudioWorkletGlobalScope 无模块加载器（不能用 import/TS 产物），小文件默认被 Vite 内联为 data: URL，而 data:-worklet 在 Firefox/Safari 上有 addModule 兼容坑，`?no-inline` 强制出外链文件
**代价**：上行 POST 频率 10.8/s → ~43/s（LAN 可忽略；如需再降可做 2~4 块合批或二进制通道）；AudioWorklet 要求 iOS 14.1+ / Chrome 66+（2020+ 设备，实际无影响）；每轮 start 多一次 addModule（浏览器按 URL 缓存，代价一个 Promise）；worklet 文件脱离 TS/测试基建，正确性依赖评审 + 真机验证。

### A15：后台续传——静默保活音源 + 回前台恢复

**决策**：录音（Tap 持续态）或播放开启期间，在输出 AudioContext 上挂一个 1s 静音循环源（`setKeepAlive`）：页面被标记「正在播放音频」，与「正在采集音频」共同构成浏览器冻结/重度节流的豁免信号；录制链路热路径（worklet 消息、网络事件、`currentTime` 排程）不依赖定时器，后台节流不阻断。同时补齐回前台恢复：`visibilitychange` → 对被挂起的输出/采集两个 context 显式 `resume()`（移动端挂起后不自动恢复）。
**理由**：
- 移动端浏览器以「是否有活跃媒体/采集」为后台豁免依据——静默音源是零权限、零 UI 成本的最低保活信号
- 采集豁免与播放豁免互补：仅录音场景补播放维度，仅播放场景本身即播放态
- 定时器在后台被节流至 ≥1s：现有保活 ping（15s）与会话 TTL（90s）的余量在节流后依然成立，无需改动
**代价与平台矩阵（诚实版）**：
- Android Chrome / 桌面 Chrome：录音与播放均可在后台持续（依据冻结豁免策略；保活期间标签显示「播放中」指示为静默内容误报，接受）
- iOS Safari：后台 JS 被系统级挂起、麦克风采集被 OS 收回——网页技术不可解；回前台经本项恢复逻辑自动续跑（状态不丢，后台期间音频不进上行链路）