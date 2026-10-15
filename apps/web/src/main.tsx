// HTTP → HTTPS 自动跳转（安全上下文要求）
// localhost 免跳：桌面浏览器 localhost 即安全上下文
if (
  window.location.protocol === 'http:' &&
  !window.location.hostname.startsWith('localhost') &&
  !window.location.hostname.startsWith('127.')
) {
  window.location.replace(`https://${window.location.host}${window.location.pathname}${window.location.search}`)
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles/globals.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)