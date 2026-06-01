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
// Supervision (mirrors CatCafe's ServiceManager auto-retry idea): the API child
// is RESTARTED on an unexpected exit, up to MAX_API_RESTARTS times, with each
// restart logged. The web dev server is fail-fast (its death brings the platform
// down) — only the long-running API is worth auto-recovering. SIGINT/SIGTERM and
// exhausting the restart budget bring everything down cleanly.
//
// This launcher is a dev-ops script, NOT product code, so it may use console.*
// (it is outside the eslint product glob: packages/**/*.ts + tests/**/*.ts).

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Cap auto-restarts so a crash-loop (e.g. a bad config) eventually gives up
// instead of spinning forever. After this many restarts the platform shuts down.
const MAX_API_RESTARTS = 5;

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

// Belt-and-suspenders: the API's composition root (main.ts) also ensures this
// dir exists, but create it here too so the resolved agent cwd is valid no matter
// which entry the user runs. (main.ts is the canonical fix; this covers `pnpm app`.)
mkdirSync(workspace, { recursive: true });

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
    if (child && child.exitCode === null) child.kill('SIGTERM');
  }
  process.exit(code);
}

/** Spawn one labelled child, wiring its prefixed stdout/stderr. */
function spawnChild(label, command, args) {
  console.log(`[launch] starting ${label}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: ROOT,
    env: childEnv,
    shell: true,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  prefixStream(label, child.stdout, (l) => console.log(l));
  prefixStream(label, child.stderr, (l) => console.error(l));
  return child;
}

const apiSpec = procs.find((p) => p.label === 'api');
const webSpec = procs.find((p) => p.label === 'web');

// API: supervised with capped auto-restart. A non-zero / unexpected exit while
// not shutting down restarts the child (logged), up to MAX_API_RESTARTS.
let apiRestarts = 0;
function startApi() {
  const child = spawnChild(apiSpec.label, apiSpec.command, apiSpec.args);
  children[0] = child;
  child.on('exit', (code) => {
    console.error(`[launch] api exited with code ${code ?? 'null'}`);
    if (shuttingDown) return;
    if (apiRestarts >= MAX_API_RESTARTS) {
      console.error(
        `[launch] api exceeded ${MAX_API_RESTARTS} restarts — giving up, shutting down`,
      );
      shutdown(code ?? 1);
      return;
    }
    apiRestarts += 1;
    console.error(`[launch] restarting api (attempt ${apiRestarts}/${MAX_API_RESTARTS})`);
    startApi();
  });
}

// Web: fail-fast — its death brings the whole platform down (dev server).
function startWeb() {
  const child = spawnChild(webSpec.label, webSpec.command, webSpec.args);
  children[1] = child;
  child.on('exit', (code) => {
    console.error(`[launch] web exited with code ${code ?? 'null'}`);
    shutdown(code ?? 1);
  });
}

startApi();
startWeb();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.error(`[launch] received ${sig} — shutting down`);
    shutdown(0);
  });
}
