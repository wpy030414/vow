import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'
import { createAudioRoutes } from './routes/audio'
import { createSseRoutes } from './routes/sse'
import { createKeyRoutes } from './routes/keys'
import { sseHub } from './services/sse-hub'
import { initVirtualAudio } from './services/virtual-audio'
import { loadConfig } from './services/config'
import { AudioArchive } from './services/audio-archive'
import { createDictationEngine, type DictationEngine } from './services/asr-dictation'
import { iflytekEngineFactory, resolveAsrConfig } from './services/iflytek-asr'
import { typeText } from './services/typing'
import { ensureCert } from './services/tls-cert'
import { createAuthMiddleware, createTokenStore } from './services/auth'
import { printPairingCode } from './services/pairing-qr'
import { createPairRoutes } from './routes/pair'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 上溯定位仓库根——dev（src/）与 prod（dist/）层级不同，以 pnpm-workspace.yaml 为锚 */
function findRepoRoot(start: string): string {
  let dir = start
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(start, '..', '..')
}

const repoRoot = findRepoRoot(__dirname)

// 运行期配置全部来自 <repoRoot>/config.yml（A16）；环境变量仅 PORT 一个逃生口
const appConfig = loadConfig({ repoRoot })
const PORT = appConfig.port

// 虚拟麦克风（VB-Cable）默认关闭：关闭时连 PortAudio worker 都不会初始化
const virtualAudio = initVirtualAudio({ inputEnabled: appConfig.virtualAudio.enabled })

/** .vow/：TLS 证书与配对令牌的存放地（gitignored） */
const vowDir = join(repoRoot, '.vow')
const tokenStore = createTokenStore(vowDir)
const pairingToken = tokenStore.token

// 上行录音落盘（DECISIONS A23）：默认关闭——关闭时不建实例、不创建目录，录音热路径零开销
const archive = appConfig.recording.enabled ? new AudioArchive(join(vowDir, 'recordings')) : null
if (archive) console.log('[Archive] 录音落盘已开启 → .vow/recordings/')

const app = new Hono()

app.get('/api/health', (c) => c.json({ status: 'ok' })) // 探活——无泄密面，保持免鉴权

// ⚠ 顺序即安全边界：/api/pair 必须在鉴权中间件【之前】注册（Hono 的 app.use 只作用于其后注册的路由）
app.route('/api', createPairRoutes({ token: pairingToken, getToken: () => tokenStore.token }))
app.use(
  '/api/*',
  createAuthMiddleware(() => tokenStore.token),
)

app.route('/api/sse', createSseRoutes({ appMode: appConfig.mode }))
app.route('/api/audio', createAudioRoutes({ appMode: appConfig.mode }))
app.route('/api/keys', createKeyRoutes())

const clientDir = join(__dirname, 'client')
if (existsSync(clientDir)) {
  app.get('/assets/*', async (c) => {
    const filePath = join(clientDir, c.req.path)
    if (!existsSync(filePath)) return c.notFound()
    const ext = filePath.split('.').pop() || ''
    const mime: Record<string, string> = {
      js: 'application/javascript',
      mjs: 'application/javascript',
      css: 'text/css',
      html: 'text/html',
      svg: 'image/svg+xml',
      png: 'image/png',
      ico: 'image/x-icon',
      json: 'application/json',
      woff2: 'font/woff2',
      woff: 'font/woff',
    }
    return c.body(readFileSync(filePath), 200, {
      'Content-Type': mime[ext] || 'application/octet-stream',
    })
  })

  app.get('*', (c) => {
    if (c.req.path.startsWith('/api')) return c.notFound()
    const html = readFileSync(join(clientDir, 'index.html'), 'utf-8')
    return c.html(html)
  })
}

sseHub.start()
await virtualAudio.start()

// ─── 听写联动接线 ───
// 引擎抽象见 services/asr-dictation.ts；当前唯一实现是 iflytek-api（凭据 base64 内置，零配置）：
// codex-micro 形态下 hold 按下 + 「转文字」开启时激活；qwennote-eva 形态下由服务端
// 策略强制恒随录音态（tap 翻转即开/收）。收尾后最终文本经 typeText 打入焦点窗口。
// 将来新增渠道：在 asr-dictation 的 id 联合类型与注册表中登记即可，本处接线不变。

const DICTATION_ENGINE_ID = 'iflytek-api' as const
const dictation: DictationEngine = createDictationEngine(
  DICTATION_ENGINE_ID,
  {
    onFinalText: async (text) => {
      await typeText(text)
    },
  },
  {
    'iflytek-api': iflytekEngineFactory({ cfg: resolveAsrConfig() }),
  },
)

// 上行音频接线：会话就绪（新建或复活）时挂载 onAudioChunk——
// 虚拟麦克风写入 + ASR 消费（ASR 未激活时内部 no-op）。
// 走 onSessionInit 钩子而非猴补丁 createSession：复活路径（服务端重启后 EventSource 重连）
// 同样会经过 registerSession，接线不会漏。
sseHub.onSessionInit = (session) => {
  session.onAudioChunk = ({ data, sampleRate }) => {
    virtualAudio.writeInputPCM({ data, sampleRate })
    dictation.feed(data, sampleRate)
    archive?.write(session.id, data, sampleRate)
  }
}

// 会话销毁（TTL 回收 / 页面关闭）即收尾该会话的录音文件
sseHub.onSessionDestroyed = (sessionId) => {
  void archive?.close(sessionId)
}

virtualAudio.setOutputCallback((pcm: Buffer) => {
  sseHub.broadcastOutputAudio(pcm)
})

// 听写联动：hold 按下（前端开「转文字」）→ 开会话；松开或会话销毁（页面关闭/断线/TTL 回收）→ 收尾
sseHub.onDictationChange = (active, sessionId, reason) => {
  if (active) {
    dictation.start()
  } else {
    console.log(`[ASR] 收尾（${reason}:${sessionId}）`)
    void dictation.stop()
  }
}

console.log(
  `Server starting on https://localhost:${PORT}（前端形态：${appConfig.mode}${appConfig.mode === 'qwennote-eva' ? '——仅 Tap · 无耳返 · ASR 恒开' : ''}；听写引擎：${DICTATION_ENGINE_ID}；虚拟麦克风：${appConfig.virtualAudio.enabled ? '开' : '关'}；录音落盘：${appConfig.recording.enabled ? '开' : '关'}）`,
)
const { key, cert } = ensureCert(vowDir)
serve({
  fetch: app.fetch,
  port: PORT,
  createServer: createHttpsServer,
  serverOptions: { key, cert },
})

// 配对二维码：生产形态（内置前端）打印；dev 下前端在 Vite(48086)——用 `pnpm pair --port 48086`
if (existsSync(clientDir)) {
  printPairingCode(PORT, pairingToken)
} else {
  console.log('[Auth] dev 模式——配对二维码请运行: pnpm pair --port 48086')
}

const shutdown = async () => {
  console.log('\nShutting down...')
  dictation.cancel()
  // 录音收尾：回填 WAV 头后再退出（正常退出路径；强杀由下次启动修补）
  if (archive) await Promise.race([archive.closeAll(), new Promise((r) => setTimeout(r, 1500))])
  // PortAudio worker 宽限（其内部另有 2s 上限），超时即强制退出
  await Promise.race([virtualAudio.stop(), new Promise((r) => setTimeout(r, 1500))])
  sseHub.stop()
  tokenStore.close()
  process.exit(0)
}
process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
