# AGENTS.md

## 项目信息

- **项目名**：vow
- **描述**：将手机浏览器变成宿主机无线麦克风，通过 SSE 实时传输音频并在系统中模拟为音频输入/输出设备
- **技术栈**：pnpm monorepo / Hono 4 / React 19 + Vite / shadcn/ui / SSE / node:sqlite + Drizzle

## 架构速查

| 组件 | 端口 | 职责 |
|------|------|------|
| `apps/server` | 48085 | Hono API + SSE hub + 虚拟音频设备 + 静态文件托管 |
| `apps/web` | 48086（dev） | React SPA，录制模式 UI + Mic 采集 + SSE 音频上传 |
| `packages/shared` | - | 类型定义、常量 |

## 关键约定

- 所有 API 在 `/api/*` 路径下
- SSE 端点：`/api/sse`
- 虚拟音频：宿主端使用 Node.js 音频库模拟输入/输出设备
- 录制模式：`hold`（按住）和 `tap`（点击切换）
- 输出设备开关：前端勾选后在系统中注册虚拟输出设备，手机通过 Web Audio 播放接收到的系统音频