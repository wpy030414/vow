# vow

> 将手机变成宿主机无线麦克风的 Web 应用

## 概述

vow 通过浏览器将手机等移动设备的麦克风音频实时传输到宿主机，在系统中模拟为一个普通麦克风设备。同时支持反向音频输出——手机可收听宿主机的系统声音。

### 核心功能

- **录制模式**：支持 Hold（按住说话）和 Tap（点击切换）两种录音模式
- **SSE 实时传输**：音频数据通过 Server-Sent Events 实时推送到宿主机后端
- **虚拟麦克风**：宿主机后端在系统中创建虚拟音频输入设备，供其他应用使用
- **反向音频输出**（可选项）：手机可作为系统音频输出设备，收听宿主机的系统声音
- **配对鉴权**：终端二维码配对（`pnpm pair`），全部 API 经 HttpOnly cookie 鉴权，防同一 WiFi 内未授权访问

## 快速开始

### 前置要求

- Node.js ≥ 20
- pnpm ≥ 9

### 安装

```bash
pnpm install
```

开箱即用：默认听写引擎 `iflytek-api` 的凭据已 base64 内置源码，无需任何环境配置。
如需切换引擎（`win-dictation`）、自定义端口或覆盖凭据，可选：`cp .env.example .env` 并按注释修改。

### 开发

```bash
pnpm dev
```

- 前端：http://localhost:48086
- 后端 API：http://localhost:48085/api/health

### 生产构建

```bash
pnpm build
pnpm start
```

访问 https://localhost:48085 即可使用。

### 首次配对

所有 API 需配对后才能访问（防止同一 WiFi 内的未授权设备窃听系统音频或向宿主注入内容）：

```bash
pnpm pair                  # 终端打印配对二维码（dev 模式用 pnpm pair --port 48086）
pnpm pair --rotate         # 轮换令牌——所有已配对设备立即失效
```

手机扫描终端二维码即完成配对，**一次配对长期有效**（cookie 180 天）。令牌持久于 `.vow/pairing-token`（gitignored），服务重启不换码。

## 安全

- 全部 `/api/*`（除 `/api/pair`、`/api/health`）需配对凭据；凭据为 128-bit 随机令牌，仅出现于宿主机终端二维码与手机 HttpOnly cookie
- 开启「转文字」时，麦克风音频会实时上传至讯飞私有 ASR（协议细节见 `scripts/recon/FINDINGS.md`）；其余音频仅在宿主机本地链路流转

## 项目结构

```
vow/
├── apps/
│   ├── server/          # Hono 后端服务
│   └── web/             # React 前端（Vite + shadcn/ui）
├── packages/
│   └── shared/          # 前后端共享类型与常量
└── docs/                # 设计文档
```

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | React 19 + Vite |
| UI 组件 | shadcn/ui (Radix + Tailwind) |
| 后端框架 | Hono 4 |
| 实时通信 | SSE (Server-Sent Events) |
| 构建 | tsup (server) + Vite (web) |
| 包管理 | pnpm workspace |