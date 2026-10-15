import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'
import { audioRoutes } from './routes/audio'
import { sseRoutes } from './routes/sse'
import { sseHub } from './services/sse-hub'
import { virtualAudio } from './services/virtual-audio'
import { createDictation, resolveEngineConfig } from './services/dictation'
import { loadNativeKeys } from './services/win32-keys'
import { createAsrDictation, resolveAsrConfig, type AsrDictation } from './services/iflytek-asr'
import { typeText } from './services/typing'
import { ensureCert } from './services/tls-cert'

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

const app = new Hono()

app.use('*', cors())

app.get('/api/health', (c) => c.json({ status: 'ok' }))
app.route('/api/sse', sseRoutes)
app.route('/api/audio', audioRoutes)

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

const _origCreate = sseHub.createSession.bind(sseHub)
sseHub.createSession = function (deviceName?: string, mode?: import('@vow/shared/types').RecordMode) {
  const session = _origCreate(deviceName, mode)
  session.onAudioChunk = ({ data, sampleRate }) => {
    virtualAudio.writeInputPCM({ data, sampleRate })
    asrCtl?.feed(data, sampleRate) // ASR 未激活时内部 no-op
  }
  return session
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
const { key, cert } = ensureCert()
serve({ fetch: app.fetch, port: PORT, createServer: createHttpsServer, serverOptions: { key, cert } })

const shutdown = async () => {
  console.log('\nShutting down...')
  asrCtl?.cancel()
  dictation.releaseNow('shutdown')
  // PortAudio worker 宽限（其内部另有 2s 上限），超时即强制退出
  await Promise.race([virtualAudio.stop(), new Promise((r) => setTimeout(r, 1500))])
  sseHub.stop()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
