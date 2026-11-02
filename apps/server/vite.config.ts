import { defineConfig } from 'vite-plus'

export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist',
    clean: true,
    dts: false,
    platform: 'node',
    // tsdown 的 ESM 默认产物为 .mjs；这里固定为 .js，与 start 脚本一致
    outExtensions: () => ({ js: '.js' }),
    // 内联 workspace 包（含子路径导出 @vow/shared/*），使 dist/ 自包含
    deps: { alwaysBundle: [/^@vow\//] },
  },
})
