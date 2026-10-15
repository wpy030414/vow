import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..')
config({ path: join(repoRoot, '.env') })

const PORT = parseInt(process.env.PORT || '48085', 10)

const app = new Hono()

// API 路由
app.get('/api/health', (c) => c.json({ status: 'ok' }))

// --- 生产模式：托管前端静态文件 ---
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

console.log(`Server starting on port ${PORT}...`)
serve({ fetch: app.fetch, port: PORT })