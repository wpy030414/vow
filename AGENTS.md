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
| `packages/portaudio` | - | PortAudio 封装（koffi FFI + 自持 DLL，worker 线程，零安装期编译） |

## 关键约定

- 所有 API 在 `/api/*` 路径下
- 鉴权：除 `/api/pair`、`/api/health` 外全部需配对 cookie——`pnpm pair` 打印二维码 / `--rotate` 轮换，令牌持久于 `.vow/pairing-token`
- SSE 端点：`/api/sse`
- 辅助键：`POST /api/keys/press`（`backspace` / `enter`）经 user32 注入宿主机焦点窗口；录音中前端禁用
- 虚拟音频：宿主端经 koffi FFI 直连自持 PortAudio DLL（@vow/portaudio，worker 线程），零安装期编译
- 录制模式：`hold`（按住）和 `tap`（点击切换）
- 输出设备开关：前端勾选后在系统中注册虚拟输出设备，手机通过 Web Audio 播放接收到的系统音频