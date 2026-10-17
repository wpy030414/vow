# vow

> 把手机变成宿主机的无线麦克风，并让手机反过来当宿主机的无线听筒。

## 概述

vow 让任何带浏览器的手机 / 平板，通过局域网变身为宿主机的无线麦克风：手机采集的音频经 SSE 实时上传宿主机，宿主机把它写入一个**虚拟音频输入设备**，于是 Zoom、OBS、DAW 等任意桌面应用都能把它当普通麦克风用。

反向通路同样成立：开启「输出设备」后，宿主机以 WASAPI 回环捕获**系统输出音频**（音乐、会议声）并推回手机，由手机实时播放——此时手机就是一个无线监听音箱，输出走扬声器而非听筒。

另有一条**语音转文字**通路：Hold 模式按住说话时，音频实时送讯飞 ASR，转写结果直接打进宿主机当前焦点窗口（例如终端里的 Claude Code），无需登录任何云语音账号。

> ⚠ **仅支持 Windows 10 / 11（x64）**。虚拟音频写入（WASAPI）、系统音频回环捕获、按键 / 文本注入、以及所依赖的虚拟声卡驱动（VB-Cable）均为 Windows 专属实现。macOS / Linux 未支持。

## 功能

| 功能 | 说明 |
|------|------|
| 无线麦克风 | Hold（按住说话）/ Tap（点按切换）两种模式；AudioWorklet 采集，1024 采样块（≈23ms）上行 |
| 虚拟音频输入设备 | 宿主机系统内出现一个麦克风端点，供任意应用读取 |
| 反向监听（可选） | 宿主系统音频 → 手机实时播放；输出经**扬声器**而非听筒 |
| 语音转文字（可选） | Hold + 「转文字」：讯飞 ASR 转写并注入宿主焦点窗口 |
| 配对鉴权 | 二维码换取 HttpOnly cookie，全部 API 收口 |
| 后台续传 | 熄屏 / 切后台时录音与播放尽量持续（受平台能力所限，见「已知边界」） |

## 平台与前置要求

- **Windows 10 / 11（x64）**
- **Node.js ≥ 22.12**（vitest 5 的 engines 要求为 `^22.12 || ^24 || >=26`，故 23 / 25 不受支持；开发环境为 Node 26）
- **pnpm**（建议最新稳定版；开发环境为 pnpm 12，workspace 配置用到 `allowBuilds`）
- **VB-Cable 虚拟音频驱动**——vow 不自造虚拟声卡，而是**写入 VB-Cable 提供的 `CABLE Input` 端点**。首次使用必须先安装（见第二步），安装后**需重启系统**，端点才会出现。

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 安装虚拟音频驱动（首次必做）

```bash
pnpm get-driver        # 需要【管理员权限】；自动下载并安装 VB-Cable
```

安装完成后**重启系统**。重启后系统中会出现 `CABLE Input` / `CABLE Output` 端点——虚拟麦克风与反向监听都跑在它上面。

> 为什么不能省：VB-Cable 是「根枚举虚拟设备」，`pnputil` 直接注册 INF 只会把驱动包登记进仓库、**不会创建设备节点**（设备必须由厂商安装器创建），且装完必须重启。这一步无法免依赖、也无法免重启。

### 3. 开发

```bash
pnpm dev
```

- 前端（Vite，热更新）：**https://localhost:48086**
- 后端（Hono）：**https://localhost:48085**（探活 `GET /api/health`）

> **dev 与 prod 都是 HTTPS（自签名证书）。** 首次 `pnpm dev` 会在仓库根 `.vow/` 下生成证书（SAN 含本机全部局域网 IP），Vite 与后端共用。手机首次访问需在浏览器点「继续访问」信任该证书——**浏览器要求安全上下文才允许麦克风**，因此不能用明文 HTTP 访问。

辅助命令：`pnpm typecheck`（全量类型检查）、`pnpm test`（单元测试）、`pnpm portaudio-check`（PortAudio 链路冒烟，`--cable` 可向 CABLE 端点写正弦）。

### 4. 生产构建

```bash
pnpm build      # 构建前端 + 后端
pnpm start      # 单进程：后端托管前端静态文件
```

手机访问 **https://<宿主机局域网 IP>:48085**（同样需信任自签证书）。

### 5. 登录自启（可选）

```bash
pnpm run-when-os-starts            # 注册任务计划程序 ONLOGON 任务并立即启动
pnpm run-when-os-starts status     # 查看任务状态 / 上次运行结果 / 遗留 Run 键
pnpm run-when-os-starts uninstall  # 注销任务（不停止当前进程）
```

采用**任务计划程序**（用户登录时于交互式会话启动，无执行时限），而非 HKCU Run 键——Windows 上 detached 进程仍属于父进程的 Job Object，终端 / IDE / Agent 会话关闭时会连同进程树一起被终止（表现为服务静默消失、连退出码都来不及写）；计划任务启动的进程挂在系统服务下，不受宿主会话影响。注册无需管理员权限，且不保留 Run 键兜底。

**崩溃守护**：启动器内置守护循环——服务异常退出后 **5s 内自动拉起**；连续 4 次快速失败后转为每 **60s** 重试（避免日志刷屏），运行超过 60s 的服务退出后重新计数。正常停止（退出码 0）不重启。任务计划程序侧的失败重启设置（每分钟、最多 999 次）作为启动器自身被杀等极端情况的兜底。启动日志：`.vow/startup.log`。

## 手机配对

除 `/api/pair`、`/api/health` 外，所有 API 均需配对鉴权（防止同一 WiFi 内任意设备窃听系统音频、或向宿主焦点窗口注入内容）：

```bash
pnpm pair                  # 终端打印配对二维码（默认端口 48085，生产形态）
pnpm pair --port 48086     # dev 形态（手机直连 Vite dev server）
pnpm pair --rotate         # 轮换令牌——所有已配对设备立即失效
```

手机扫码或直接访问终端打印的 URL 即完成配对；**一次配对长期有效**（cookie 180 天）。令牌持久于 `.vow/pairing-token`（gitignored），服务重启不换码。

## 安全与隐私

- 配对凭据为 128-bit 随机令牌，仅出现于宿主机终端二维码与手机的 HttpOnly cookie（`SameSite=Strict`）
- **开启「转文字」时**，麦克风音频会实时上传至**讯飞私有 ASR 云端**（凭据 base64 内置源码，可用 env 逐字段覆盖）；**关闭时**音频只在宿主机本地链路流转
- 上行麦克风音频与下行系统音频均只在**局域网内**（宿主机 ↔ 手机）流转，不经第三方中转

## 已知边界

- **仅 Windows**——见「平台与前置要求」
- **必须装 VB-Cable 并重启**，无法免依赖运行
- **iOS 扬声器路由**：`navigator.audioSession` 需 iOS 16.4+；更低的版本上，一旦用过麦克风，外放会被系统锁在「听筒」（网页层不可解）
- **后台续传分平台**：Android Chrome / 桌面 Chrome 可在后台持续采集与播放；iOS Safari 后台会被系统挂起并收回麦克风，回前台自动恢复（后台期间音频不进上行链路）
- **听写为私有协议**：`iflytek-api` 是逆向实现的讯飞私有 ASR 直连，存在被服务端升级破坏的风险（用 `VOW_DICTATION_ENGINE=win-dictation` 一行 env 可切回 Win+H 保底引擎）
- 讯飞凭据为设备级内置，仅供本机个人使用

## 项目结构

```
vow/
├── apps/
│   ├── server/          # Hono 后端：SSE hub、虚拟音频、听写联动、静态托管
│   └── web/             # React 前端：录制 UI、采集（AudioWorklet）、下行播放
├── packages/
│   ├── shared/          # 前后端共享类型与常量
│   └── portaudio/       # PortAudio 封装（koffi FFI + 自持 DLL，worker 线程）
├── scripts/             # get-driver / pair / portaudio-check 等运维脚本
└── docs/                # PRD / ARCHITECTURE / DECISIONS
```

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite + shadcn/ui（Radix + Tailwind） |
| 后端 | Hono 4 + `@hono/node-server`（HTTPS） |
| 实时通信 | SSE（上行 POST 音频块 / 下行 push） |
| 音频 | 手机端 Web Audio / AudioWorklet；宿主端 PortAudio（koffi FFI + worker 线程） |
| 虚拟驱动 | VB-Cable（外部依赖，非本项目提供） |
| 构建 | tsup（server）+ Vite（web） |
| 包管理 | pnpm workspace |

## 相关文档

- [`docs/PRD.md`](docs/PRD.md) — 产品需求
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 架构与数据链路
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — 架构决策记录（ADR）
- [`scripts/recon/FINDINGS.md`](scripts/recon/FINDINGS.md) — 讯飞私有 ASR 逆向记录
