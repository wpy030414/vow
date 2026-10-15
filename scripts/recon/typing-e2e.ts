// typing-e2e.ts — 把一段中英混排文本注入当前焦点窗口（配合 typing-e2e.ps1 验证）
import { typeText } from '../../apps/server/src/services/typing'

const TEXT = 'vow 中文测试 123，标点。'
const ok = await typeText(TEXT, { intervalMs: 12 })
console.log(`[e2e] 注入${ok ? '成功' : '失败'}：${JSON.stringify(TEXT)}`)
