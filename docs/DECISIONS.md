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