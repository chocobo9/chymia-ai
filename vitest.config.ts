import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const pkg = (p: string): string => resolve(import.meta.dirname, p)

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@clowder\/shared$/, replacement: pkg('packages/shared/src/index.ts') },
      { find: /^@clowder\/shared\/(.*)$/, replacement: pkg('packages/shared/src/$1') },
      { find: /^@clowder\/api$/, replacement: pkg('packages/api/src/index.ts') },
      { find: /^@clowder\/api\/(.*)$/, replacement: pkg('packages/api/src/$1') },
      { find: /^@clowder\/mcp-server$/, replacement: pkg('packages/mcp-server/src/index.ts') },
      { find: /^@clowder\/mcp-server\/(.*)$/, replacement: pkg('packages/mcp-server/src/$1') },
      { find: /^@clowder\/adapters$/, replacement: pkg('packages/adapters/index.ts') },
      { find: /^@clowder\/adapters\/(.*)$/, replacement: pkg('packages/adapters/$1') },
      { find: /^@clowder\/skills$/, replacement: pkg('packages/skills/src/index.ts') },
      { find: /^@clowder\/skills\/(.*)$/, replacement: pkg('packages/skills/src/$1') },
      { find: /^@clowder\/web$/, replacement: pkg('packages/web/src/index.ts') },
      { find: /^@clowder\/web\/(.*)$/, replacement: pkg('packages/web/src/$1') },
    ],
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/ui/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
    passWithNoTests: true,
    hookTimeout: 20000,
    testTimeout: 20000,
  },
})
