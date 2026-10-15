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
import { ensureCert } from './services/tls-cert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
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
virtualAudio.start()

const _origCreate = sseHub.createSession.bind(sseHub)
sseHub.createSession = function (deviceName?: string, mode?: import('@vow/shared/types').RecordMode) {
  const session = _origCreate(deviceName, mode)
  session.onAudioChunk = ({ data, sampleRate }) => {
    virtualAudio.writeInputPCM({ data, sampleRate })
  }
  return session
}

virtualAudio.setOutputCallback((pcm: Buffer) => {
  sseHub.broadcastOutputAudio(pcm)
})

console.log(`Server starting on https://localhost:${PORT}`)
const { key, cert } = ensureCert()
serve({ fetch: app.fetch, port: PORT, createServer: createHttpsServer, serverOptions: { key, cert } })

const shutdown = () => {
  console.log('\nShutting down...')
  virtualAudio.stop()
  sseHub.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)