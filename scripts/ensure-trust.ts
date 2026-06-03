// scripts/ensure-trust.ts — interactive workspace-trust prompt (VSCode-style).
//
// Run by the launcher BEFORE the agents start (and, later, by the packaged app's
// startup — swapping this readline prompt for a GUI dialog). Asks ONCE per
// workspace and remembers the answer in the shared WorkspaceTrustStore, which the
// API (main.ts) then reads to decide whether to enable gemini's headless
// auto-approve. Persisting here keeps a single source of truth for trust.
//
// Usage: npx tsx scripts/ensure-trust.ts <workspace>
//   already trusted        → exit 0
//   CHOCO_TRUST_WORKSPACE=1 → trust + remember → exit 0
//   interactive TTY        → [y/N] prompt → persist on yes
//   non-interactive        → warn how to trust, exit 0 (never blocks startup)
//
// Dev-ops script (scripts/, outside the lint/type gate globs) → console.* is OK
// for its terminal UX.

import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import {
  WorkspaceTrustStore,
  resolveTrustStorePath,
  isTrustFlagSet,
  TRUST_FLAG_ENV,
} from '@choco/api/runtime/workspace-trust';

async function main(): Promise<void> {
  const workspaceArg = process.argv[2];
  if (workspaceArg === undefined || workspaceArg.length === 0) {
    console.error('[trust] usage: tsx scripts/ensure-trust.ts <workspace>');
    process.exit(2);
  }
  const workspace = resolve(workspaceArg);
  const store = new WorkspaceTrustStore(resolveTrustStorePath());

  if (store.isTrusted(workspace)) {
    console.log(`[trust] 工作目录已信任：${workspace}`);
    return;
  }
  if (isTrustFlagSet(process.env[TRUST_FLAG_ENV])) {
    store.trust(workspace);
    console.log(`[trust] 已通过 ${TRUST_FLAG_ENV} 信任并记住：${workspace}`);
    return;
  }
  if (process.stdin.isTTY !== true) {
    console.warn(
      `[trust] 工作目录未信任，且当前为非交互启动：${workspace}\n` +
        `        gemini 等需要「信任目录」的功能将受限。用交互式 \`pnpm app\` 信任一次，或设 ${TRUST_FLAG_ENV}=1。`,
    );
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) =>
    rl.question(
      `\n是否信任此工作目录，并允许 AI agent 在其中读写文件 / 自动执行工具？\n  ${workspace}\n[y/N] `,
      res,
    ),
  );
  rl.close();

  if (/^y(es)?$/i.test(answer.trim())) {
    store.trust(workspace);
    console.log('[trust] 已信任并记住此目录。');
  } else {
    console.log('[trust] 已拒绝 — 以受限模式继续（gemini 等需要信任的功能不可用）。');
  }
}

void main();
