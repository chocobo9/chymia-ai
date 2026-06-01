// scripts/launch.mjs — one-command launcher for the Clowder platform.
//
// Spawns BOTH halves of the running system together and streams their logs with
// a per-process prefix:
//   - API  : `npx tsx packages/api/src/main.ts`         (the composition root)
//   - WEB  : `pnpm --filter @clowder/web dev`           (the Vite dev server)
//
// Run with:  pnpm app    (root package.json script)  — or  node scripts/launch.mjs
//
// Environment (forwarded to the API; see packages/api/src/main.ts header):
//   CHOCO_WORKSPACE        local dir agents work in (default: a logged safe dir)
//   CHOCO_PERMISSION_MODE  claude permission mode (default: acceptEdits)
//   PORT / HOST            API listen port / host (default: 3000 / 0.0.0.0)
//
// This launcher is a dev-ops script, NOT product code, so it may use console.*
// (it is outside the eslint product glob: packages/**/*.ts + tests/**/*.ts).

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Default workspace: a clearly-logged safe dir under the repo, so an unset
// CHOCO_WORKSPACE never silently points real agents at an unexpected directory.
const DEFAULT_WORKSPACE = resolve(ROOT, '.workspace');

const workspace = process.env.CHOCO_WORKSPACE ?? DEFAULT_WORKSPACE;
if (process.env.CHOCO_WORKSPACE === undefined) {
  console.warn(
    `[launch] CHOCO_WORKSPACE unset — defaulting agents' workspace to ${workspace}. ` +
      `Set CHOCO_WORKSPACE=<dir> to point agents at your project.`,
  );
}

const childEnv = { ...process.env, CHOCO_WORKSPACE: workspace };

// On Windows the npx/pnpm launchers are .cmd shims; spawn through a shell so the
// shim resolves. (cross-platform: shell:true also works on POSIX.)
const procs = [
  {
    label: 'api',
    command: 'npx',
    args: ['tsx', 'packages/api/src/main.ts'],
  },
  {
    label: 'web',
    command: 'pnpm',
    args: ['--filter', '@clowder/web', 'dev'],
  },
];

const children = [];
let shuttingDown = false;

function prefixStream(label, stream, sink) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      sink(`[${label}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) sink(`[${label}] ${buffer}`);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  process.exit(code);
}

for (const { label, command, args } of procs) {
  console.log(`[launch] starting ${label}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: childEnv,
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  prefixStream(label, child.stdout, (l) => console.log(l));
  prefixStream(label, child.stderr, (l) => console.error(l));
  child.on('exit', (code) => {
    console.error(`[launch] ${label} exited with code ${code ?? 'null'}`);
    // If either half dies, bring the whole platform down (fail-fast).
    shutdown(code ?? 1);
  });
  children.push(child);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`[launch] received ${sig} — shutting down`);
    shutdown(0);
  });
}
