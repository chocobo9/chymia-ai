// QA edge/adversarial — the workspace wire (buildInvokeAgentFn → invokeSingleAgent
// → provider InvokeOptions.workingDirectory). Authored by a QA instance that did
// NOT write the product wire (CLAUDE.md §0.5.3 dev≠QA). The dev's happy-path suite
// (workspace-wire.test.ts) covers the three documented cases; this file HUNTS the
// precedence/no-op guarantees and odd projectPath inputs the wire must survive.
//
// Surface under test (packages/api/src/app-factory.ts:365,386):
//   const workingDirectory = thread?.projectPath ?? deps.defaultWorkspace;
//   ...(workingDirectory !== undefined ? { workingDirectory } : {})
// A recording FakeAgentService captures the EXACT InvokeOptions the provider got,
// driven through the real HTTP /messages route so the whole seam executes.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildApp,
  type BuildAppOverrides,
  type BuiltApp,
} from '@choco/api/app-factory';
import type { InvokeOptions } from '@choco/api/providers/base';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Build an inject-only app with one claude fake + the given overrides. */
function appWithFake(
  overrides: Omit<BuildAppOverrides, 'db' | 'agentServices'> = {},
): { readonly app: BuiltApp; readonly fake: FakeAgentService } {
  // Two scripts so a thread can drive two turns in one test (retry/sequential).
  const fake = new FakeAgentService([
    replyScript(CLAUDE, '收到，开始在工作目录里操作。'),
    replyScript(CLAUDE, '第二轮：继续在同一工作目录。'),
  ]);
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: { 'claude-opus': fake }, ...overrides });
  return { app, fake };
}

/** Drive one @claude message through the real route so the fake provider runs. */
async function postMessage(app: BuiltApp, threadId: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: '@claude 在这个仓库里加一个 README', userId: 'user-makima' },
  });
}

/** Read back the workingDirectory the provider was called with on call `i`. */
function cwdOfCall(fake: FakeAgentService, i: number): string | undefined {
  const opts: InvokeOptions | undefined = fake.calls[i]?.options;
  return opts?.workingDirectory;
}

/** True iff the provider's InvokeOptions OMIT workingDirectory entirely (no-op). */
function cwdKeyPresent(fake: FakeAgentService, i: number): boolean {
  const opts: InvokeOptions | undefined = fake.calls[i]?.options;
  return opts !== undefined && Object.prototype.hasOwnProperty.call(opts, 'workingDirectory');
}

describe('workspace wire — no-op / no-regression guarantee (edge)', () => {
  it('omits the workingDirectory KEY (not undefined-but-present) when neither projectPath nor defaultWorkspace is set', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    await postMessage(app, 'thread-bare-no-key');

    // The dev guards with `...(workingDirectory !== undefined ? {workingDirectory} : {})`,
    // so the KEY must be genuinely ABSENT — a present `workingDirectory: undefined`
    // would still be a (benign) shape change vs. the pre-wire behavior. Confirm the
    // true no-op: the provider must not even see the property.
    expect(fake.calls).toHaveLength(1);
    expect(cwdKeyPresent(fake, 0)).toBe(false);
    expect(cwdOfCall(fake, 0)).toBeUndefined();
  });

  it('does not leak defaultWorkspace across threads: a projectPath thread and a bare thread on the SAME app resolve independently', async () => {
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    const projectPath = 'D:/work/auth-service';
    await app.stores.threadStore.create({ id: 'thread-proj', projectPath });
    await postMessage(app, 'thread-proj'); // call 0 → projectPath wins
    await postMessage(app, 'thread-bare-2'); // call 1 → falls back to defaultWorkspace

    expect(fake.calls).toHaveLength(2);
    expect(cwdOfCall(fake, 0)).toBe(projectPath);
    expect(cwdOfCall(fake, 1)).toBe(defaultWorkspace);
  });

  it('resolves the cwd per-turn from the LIVE thread row: two turns on one projectPath thread both receive that projectPath', async () => {
    // The wire reads thread.projectPath INSIDE invoke (app-factory.ts:331,365), so
    // every turn re-resolves from the current row rather than caching the first.
    // Two sequential turns on the same project thread must BOTH get the projectPath
    // (not just the first) — proving the resolution is per-turn, not one-shot.
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    const threadId = 'thread-two-turns';
    const projectPath = 'D:/work/auth-service';
    await app.stores.threadStore.create({ id: threadId, projectPath });

    await postMessage(app, threadId); // turn 1
    await postMessage(app, threadId); // turn 2 (same thread, same fake, 2nd script)

    expect(fake.calls).toHaveLength(2);
    expect(cwdOfCall(fake, 0)).toBe(projectPath);
    expect(cwdOfCall(fake, 1)).toBe(projectPath);
  });
});

describe('workspace wire — projectPath precedence + odd values (adversarial)', () => {
  it('thread.projectPath BEATS defaultWorkspace even when defaultWorkspace is also a valid dir', async () => {
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    const projectPath = 'D:/work/payment-service';
    await app.stores.threadStore.create({ id: 'thread-precedence', projectPath });
    await postMessage(app, 'thread-precedence');

    expect(cwdOfCall(fake, 0)).toBe(projectPath);
    expect(cwdOfCall(fake, 0)).not.toBe(defaultWorkspace);
  });

  it('EMPTY-STRING projectPath ("") is passed through as cwd, OVERRIDING defaultWorkspace (?? only short-circuits null/undefined)', async () => {
    // Adversarial precedence probe. `'' ?? defaultWorkspace` === '' in JS, so an
    // explicitly empty projectPath WINS over a configured defaultWorkspace and is
    // forwarded to the provider as workingDirectory: ''. This is a latent footgun:
    // it silently defeats the configured workspace. It is NOT a crash — Node's
    // child_process.spawn treats an empty-string cwd as "inherit parent cwd"
    // (cli-spawn.ts:71 passes it straight through). We assert the ACTUAL wire
    // behavior so a future change of the precedence semantics is caught here.
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    await app.stores.threadStore.create({ id: 'thread-empty-proj', projectPath: '' });
    await postMessage(app, 'thread-empty-proj');

    // Empty string survives the create→DB→rowToThread round-trip (it is stored,
    // not coerced to null), then `'' ?? defaultWorkspace` yields ''.
    expect(cwdOfCall(fake, 0)).toBe('');
    // The KEY is present (workingDirectory !== undefined for '').
    expect(cwdKeyPresent(fake, 0)).toBe(true);
    // It did NOT fall back to the configured workspace — the footgun.
    expect(cwdOfCall(fake, 0)).not.toBe(defaultWorkspace);
  });

  it('preserves a projectPath with a trailing slash verbatim (no normalization)', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const projectPath = 'D:/work/data-pipeline/';
    await app.stores.threadStore.create({ id: 'thread-trailing', projectPath });
    await postMessage(app, 'thread-trailing');

    expect(cwdOfCall(fake, 0)).toBe(projectPath); // exact, slash intact
  });

  it('preserves a RELATIVE projectPath verbatim (the wire does not resolve to absolute)', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const projectPath = './services/billing';
    await app.stores.threadStore.create({ id: 'thread-relative', projectPath });
    await postMessage(app, 'thread-relative');

    expect(cwdOfCall(fake, 0)).toBe(projectPath);
  });

  it('preserves a NON-EXISTENT projectPath verbatim (the wire does not stat/validate the dir)', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const projectPath = 'D:/this/path/does/not/exist/anywhere-42';
    await app.stores.threadStore.create({ id: 'thread-missing-dir', projectPath });
    await postMessage(app, 'thread-missing-dir');

    // The wire is a pure pass-through; spawn-time errors are the provider's
    // graceful spawn_error concern, not the wire's. Confirm it forwards as-is.
    expect(cwdOfCall(fake, 0)).toBe(projectPath);
  });

  it('preserves a projectPath containing spaces and unicode verbatim', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const projectPath = 'D:/work/项目 空格/支付 服务';
    await app.stores.threadStore.create({ id: 'thread-unicode', projectPath });
    await postMessage(app, 'thread-unicode');

    expect(cwdOfCall(fake, 0)).toBe(projectPath);
  });

  it('a UNC / network projectPath is forwarded verbatim (no munging of backslashes)', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const projectPath = '\\\\fileserver\\share\\repo';
    await app.stores.threadStore.create({ id: 'thread-unc', projectPath });
    await postMessage(app, 'thread-unc');

    expect(cwdOfCall(fake, 0)).toBe(projectPath);
  });
});

describe('workspace wire — defaultWorkspace odd values (adversarial)', () => {
  it('an EMPTY-STRING defaultWorkspace is forwarded as cwd: "" when no projectPath (composition root guards against this, but the factory does not)', async () => {
    // main.ts only sets defaultWorkspace from a non-empty CHOCO_WORKSPACE, but the
    // factory itself accepts any string. Probe the factory contract directly: an
    // empty defaultWorkspace is `undefined ?? ''` === '' → forwarded (key present).
    const { app, fake } = appWithFake({ defaultWorkspace: '' });
    cleanups.push(app.close);

    await postMessage(app, 'thread-empty-default');

    expect(cwdOfCall(fake, 0)).toBe('');
    expect(cwdKeyPresent(fake, 0)).toBe(true);
  });

  it('a defaultWorkspace with spaces/unicode is forwarded verbatim when no projectPath', async () => {
    const defaultWorkspace = 'C:/Users/真喜/共享 沙箱';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    await postMessage(app, 'thread-default-unicode');

    expect(cwdOfCall(fake, 0)).toBe(defaultWorkspace);
  });
});
