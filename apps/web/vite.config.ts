import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import dotenv from 'dotenv'
import { readFileSync } from 'node:fs'

dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') })
const apiPort = process.env.PORT || '48085'

// 读取由 TLS 模块生成的证书
const certDir = path.resolve(import.meta.dirname, '../../.vow')
const keyPath = path.join(certDir, 'key.pem')
const certPath = path.join(certDir, 'cert.pem')

let httpsConfig: { key: Buffer; cert: Buffer } | undefined
try {
  httpsConfig = {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  }
} catch {
  console.warn('[Vite] no TLS cert found in .vow/ — falling back to HTTP (run pnpm dev once first)')
}

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/dist/client',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 48086,
    https: httpsConfig,
    proxy: {
      '/api': {
        target: `https://localhost:${apiPort}`,
        secure: false,
        changeOrigin: true,
      },
    },
  },
})