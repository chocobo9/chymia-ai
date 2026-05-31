import { defineConfig } from '@playwright/test'

/**
 * UI e2e (M9 / M15). The web dev server is wired against the Fake provider
 * by the M15 harness via the `webServer` block, which M15 fills in.
 */
export default defineConfig({
  testDir: 'tests/e2e/ui',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:5174',
  },
  // webServer: { ... } — configured by M15 to boot Vite + API with FakeAgentService.
})
