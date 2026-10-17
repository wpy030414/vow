import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'
import { audioRoutes } from './routes/audio'
import { sseRoutes } from './routes/sse'
import { createKeyRoutes } from './routes/keys'
import { sseHub } from './services/sse-hub'
import { virtualAudio } from './services/virtual-audio'
import { createDictation, resolveEngineConfig } from './services/dictation'
import { loadNativeKeys } from './services/win32-keys'
import { createAsrDictation, resolveAsrConfig, type AsrDictation } from './services/iflytek-asr'
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
config({ path: join(repoRoot, '.env') })

const PORT = parseInt(process.env.PORT || '48085', 10)

/** .vow/：TLS 证书与配对令牌的存放地（gitignored） */
const vowDir = join(repoRoot, '.vow')
const tokenStore = createTokenStore(vowDir)
const pairingToken = tokenStore.token

const app = new Hono()

app.get('/api/health', (c) => c.json({ status: 'ok' })) // 探活——无泄密面，保持免鉴权

// ⚠ 顺序即安全边界：/api/pair 必须在鉴权中间件【之前】注册（Hono 的 app.use 只作用于其后注册的路由）
app.route('/api', createPairRoutes({ token: pairingToken, getToken: () => tokenStore.token }))
app.use('/api/*', createAuthMiddleware(() => tokenStore.token))

app.route('/api/sse', sseRoutes)
app.route('/api/audio', audioRoutes)
app.route('/api/keys', createKeyRoutes())

const clientDir = join(__dirname, 'client')
if (existsSync(clientDir)) {
  app.get('/assets/*', async (c) => {
    const filePath = join(clientDir, c.req.path)
    if (!existsSync(filePath)) return c.notFound()
    const ext = filePath.split('.').pop() || ''
    const mime: Record<string, string> = {
      js: 'application/javascript', mjs: 'application/javascript',
      css: 'text/css', html: 'text/html', svg: 'image/svg+xml',
      png: 'image/png', ico: 'image/x-icon', json: 'application/json',
      woff2: 'font/woff2', woff: 'font/woff',
    }
    return c.body(readFileSync(filePath), 200, { 'Content-Type': mime[ext] || 'application/octet-stream' })
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
// 默认 iflytek-api（凭据 base64 内置，零配置）：hold 按下开 ASR 会话（消费 onAudioChunk 的 PCM）
// → 松手收尾打字；注入 VOW_DICTATION_ENGINE=win-dictation 才切换到 Win+H 快捷键注入（toggle 引擎）

const engineCfg = resolveEngineConfig()
const asrCtl: AsrDictation | null =
  engineCfg.engine === 'iflytek-api'
    ? createAsrDictation(resolveAsrConfig(), {
        onFinalText: async (text) => {
          await typeText(text)
        },
      })
    : null
const dictation = createDictation(loadNativeKeys(), engineCfg)

// 上行音频接线：会话就绪（新建或复活）时挂载 onAudioChunk——
// 虚拟麦克风写入 + ASR 消费（ASR 未激活时内部 no-op）。
// 走 onSessionInit 钩子而非猴补丁 createSession：复活路径（服务端重启后 EventSource 重连）
// 同样会经过 registerSession，接线不会漏。
sseHub.onSessionInit = (session) => {
  session.onAudioChunk = ({ data, sampleRate }) => {
    virtualAudio.writeInputPCM({ data, sampleRate })
    asrCtl?.feed(data, sampleRate)
  }
}

virtualAudio.setOutputCallback((pcm: Buffer) => {
  sseHub.broadcastOutputAudio(pcm)
})

// 听写联动：hold 按下（前端开「转文字」）→ 开听写；松开或会话销毁（页面关闭/断线/TTL 回收）→ 收尾
sseHub.onDictationChange = (active, sessionId, reason) => {
  if (asrCtl) {
    if (active) asrCtl.start()
    else void asrCtl.stop()
  } else {
    void dictation.setDesired(active, `${reason}:${sessionId}`)
  }
}

console.log(`Server starting on https://localhost:${PORT}（听写引擎：${engineCfg.engine}）`)
const { key, cert } = ensureCert(vowDir)
serve({ fetch: app.fetch, port: PORT, createServer: createHttpsServer, serverOptions: { key, cert } })

// 配对二维码：生产形态（内置前端）打印；dev 下前端在 Vite(48086)——用 `pnpm pair --port 48086`
if (existsSync(clientDir)) {
  printPairingCode(PORT, pairingToken)
} else {
  console.log('[Auth] dev 模式——配对二维码请运行: pnpm pair --port 48086')
}

const shutdown = async () => {
  console.log('\nShutting down...')
  asrCtl?.cancel()
  dictation.releaseNow('shutdown')
  // PortAudio worker 宽限（其内部另有 2s 上限），超时即强制退出
  await Promise.race([virtualAudio.stop(), new Promise((r) => setTimeout(r, 1500))])
  sseHub.stop()
  tokenStore.close()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
