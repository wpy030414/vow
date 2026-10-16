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
### A16：虚拟麦克风端点——按设备采样率开流 + 候选端点逐一尝试

**决策**：虚拟麦克风开流不再硬编码 44100Hz，也不再靠元数据猜端点：
- 采样率改为**运行时取设备上报的 `defaultSampleRate`**（`FALLBACK_SAMPLE_RATE=44100` 仅兜底；被拒 `paInvalidSampleRate` 时沿 `[48000, 44100]` 降级重试），手机上行 PCM 按此重采样、推送节拍改为 `round(1024/rate*1000)` ms。
- `selectCableDevice`（返回单个「恰好 2 声道」端点）改为 `selectCableDevices`（返回**按可用性启发排序的候选列表**），开流时对「设备 × 采样率」组合**逐一尝试直到成功**；非采样率错误（`paInvalidDevice`）在该设备上直接换下一个候选设备。排序仅优化首次尝试顺序：WASAPI 优先 → `16ch` 端点优先 → 输出声道数越接近 2 越优先；MME/DirectSound 端点上榜但排最后兜底。
**理由**：
- WASAPI 共享模式要求 `Pa_OpenStream` 的 sampleRate 与端点混音格式**完全一致**，否则 `paInvalidSampleRate`。实机探针：`CABLE Input` 端点混音格式为 48000，而历史代码写死 44100 → 恒开流失败（正是报错 `Invalid sample rate` 的根因）。
- 更进一步：把采样率改对（48000）后，实机 `CABLE Input`（WASAPI）仍报 `paInvalidDevice`（元数据完全正常：2 声道 / 48000Hz）——**唯一能开的 WASAPI 渲染端点是 `CABLE In 16ch`**。而旧排序 `|maxOutputChannels-2|` 恰好把 plain `CABLE Input`（2 声道）排在 `CABLE In 16ch`（4 声道）之前，于是**虚拟麦克风从未成功开流过**。端点可用性无法由元数据判定 → 只能实测开流。
**代价**：开流可能多试若干「设备 × 采样率」组合（失败路径多几条 `Pa_OpenStream` 调用，成功路径通常首个命中）；候选顺序启发（`16ch` 命名偏好）是对 VB-Cable 端点命名的经验依赖，真正的正确性由「逐一尝试」保证而非排序。

### A17：SSE 会话与传输解耦——流断开只解绑，不销毁

**决策**：SSE 流的 `close` 不再销毁会话，改为 `detachStream(id, writer)` 仅解绑该连接的 `writer` 与 `onOutputAudio`（并按 writer 身份校验，避免迟到的旧连接 close 误清新连接）；会话改由保活 ping + TTL 回收统一管理。`getOrCreateStream` 对未知 id 的复活改为**按原 id 重建**（此前经 `createSession` 生成随机 id 再改写，每次重连都多记一条假 `session created`——正是刷屏的根源）。同时用 `onSessionInit` 钩子取代对 `createSession` 的猴补丁，使复活路径同样挂上 `onAudioChunk` 接线；客户端 `connect()` 加互斥旗标并在建流前先 `cleanupStream()`。
**理由**：
- 会话的语义是「客户端逻辑连接」（POST /session 建立、ping 续命、TTL 回收），SSE 流只是它的传输载体；而 EventSource 断线后**必然用同一 sessionId 自动重连**。在流 close 时就销毁会话，与 EventSource 的重连语义直接冲突 → 每次瞬时断连都上演「销毁→重连复活」的刷屏，并丢失会话状态（mode / isOutputEnabled / recording）。实测复现：对同一已销毁 id 重连 3 次 = 3 条假 `session created` + 3 条 `session destroyed`。
- 「close 即销毁」原本是为堵内存泄漏（客户端离开后 `writer.write()` 不报错 → 死会话被持续灌入音频），但解绑 writer 已同样达到目的：心跳与输出广播都按 `writer` 存在性跳过；真正离线的会话由 `reapStaleSessions` 在 TTL 后清掉并按既有逻辑释放听写。
- 客户端并发 `connect()` 各建一个会话是 active 累积成 3 的另一半原因（自动连接 / ping-404 恢复 / 配对重试多路径），互斥旗标封死。
**代价**：关闭标签页后会话最多多存活一个 TTL（90s）才被回收（期间无内存增长，仅 `connectedCount` 短暂偏大）；瞬时断连不再立刻释放听写（改为 TTL 兜底，避免重连抖动误掐进行中的听写）。

### A18：下行输出走扬声器——iOS AudioSession API + Android setSinkId

**决策**：把手机端下行播放（宿主系统音频）从系统默认路由「听筒」扳回「扬声器」，新增 `apps/web/src/lib/audio-route.ts` 按平台能力各自兜底：
- **iOS（Safari 16.4+）**：`navigator.audioSession.type`。纯输出用 `'playback'`（扬声器、高保真、无通知栏指示器），录音中置 `'play-and-record'`（麦克风 + 扬声器）——由 `App` 的 effect 依据 `recording / isOutputEnabled` 实时同步。**关键时序修复**：`playback` 类别下 iOS 拒绝 `getUserMedia`（"AudioSession category is not compatible with audio capture"），故 `useMicrophone.startRecording` 在获取媒体之前**同步**将 category 置为 `'play-and-record'`（property setter 即时生效，不依赖 React effect 的异步渲染），停录后由 `App` effect 自动落回 `'playback'`——旁路掉类别升级被拒的 iOS 限制。
- **Android（Chrome 110+）**：`AudioContext.setSinkId()`。枚举音频输出设备，仅当存在标签明确指向「扬声器」的设备时才切换；找不到则保持系统默认（绝不误切）。因设备标签经麦克风授权后才可见，授权瞬间额外触发一次重挑。

**理由**：
- 移动浏览器上页面一旦调用 `getUserMedia` 取得麦克风，系统音频会话即被切入「录放 / 通话」类别，此后**所有外放**（含本应用 Web Audio 播出的宿主系统音频）都被路由到听筒；即便停止录音，会话也常赖在录放态不归还（WebKit bug 295889 / Apple 论坛 657321 均记录此行为）——正是用户报告的现象。
- iOS 侧唯一解是 AudioSession API（`navigator.audioSession`）：显式声明会话类型才能指定路由，输出设备枚举/`setSinkId` 在 iOS Safari 上均不可用（Apple 论坛 657321 确认）。
- Android 侧 Chrome 支持 `AudioContext.setSinkId()`，但设备枚举粒度视机型而定：仅在标签可辨识扬声器时切换，保证不劣化为「意外端点」，不满足则等价空操作、保持默认。

**代价**：iOS 需 16.4+（更早版本无 `navigator.audioSession`，输出在用过麦克风后仍走听筒，属网页技术不可解）；Android 设备标签依赖麦克风授权且机型差异大，真机行为需实测，代码在无匹配设备时静默保持默认。
