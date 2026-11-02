import { defineConfig } from 'vite-plus'

export default defineConfig({
  fmt: { semi: false, singleQuote: true },
  lint: {
    ignorePatterns: ['**/node_modules/**', '**/dist/**'],
    options: { typeAware: true, typeCheck: true },
  },
})
