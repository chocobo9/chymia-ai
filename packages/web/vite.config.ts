import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@choco/shared': resolve(root, '../shared/src/index.ts'),
    },
  },
  server: {
    port: Number(process.env.WEB_PORT ?? 5174),
  },
})
