// scripts/dogfood-scratch.mjs — THROWAWAY dogfood launcher (delete after).
// Runs the wired API against a scratch workspace, edit-capable, on port 3100.
// Config baked in so the launch is a SHORT, wrap-proof command:  node scripts/dogfood-scratch.mjs
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const WORKSPACE = 'C:\\Users\\zihan\\AppData\\Local\\Temp\\choco-scratch'
mkdirSync(WORKSPACE, { recursive: true })

const env = {
  ...process.env,
  CHOCO_WORKSPACE: WORKSPACE,
  CHOCO_PERMISSION_MODE: 'acceptEdits',
  PORT: '3100',
  HOST: '127.0.0.1',
}

console.log(`[dogfood] starting wired API on 127.0.0.1:3100, workspace=${WORKSPACE}, mode=acceptEdits`)
const child = spawn('npx', ['tsx', 'packages/api/src/main.ts'], { stdio: 'inherit', env, shell: true })
child.on('exit', (code) => process.exit(code ?? 0))
