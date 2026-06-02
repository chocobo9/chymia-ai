// Dev happy-path: the workspace wire (buildInvokeAgentFn → invokeSingleAgent →
// provider options.workingDirectory). The FakeAgentService records the
// InvokeOptions it was called with, so we drive a real message through the HTTP
// route and then read back the cwd the provider would have spawned with.
//
// Three cases the wire MUST satisfy (the no-regression case is load-bearing —
// the 1295 existing tests pass neither projectPath nor defaultWorkspace and rely
// on workingDirectory staying undefined):
//   1. thread WITH projectPath        → provider gets that projectPath
//   2. only defaultWorkspace injected → provider gets the defaultWorkspace
//   3. neither                        → provider gets undefined (no cwd)
//
// QA owns edge/adversarial (e.g. projectPath winning over defaultWorkspace under
// retries, abort, blank values). Real inputs only (real @mention + agent ids).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp, type BuildAppOverrides, type BuiltApp } from '@choco/api/app-factory';
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
function appWithFake(overrides: Omit<BuildAppOverrides, 'db' | 'agentServices'> = {}): {
  readonly app: BuiltApp;
  readonly fake: FakeAgentService;
} {
  const fake = new FakeAgentService([replyScript(CLAUDE, '收到，开始在工作目录里操作。')]);
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: { 'claude-opus': fake }, ...overrides });
  return { app, fake };
}

/** Drive one @claude message through the route so the fake provider is invoked. */
async function postMessage(app: BuiltApp, threadId: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: '@claude 在这个仓库里加一个 README', userId: 'user-makima' },
  });
}

describe('workspace wire (happy path)', () => {
  it('passes thread.projectPath as the provider workingDirectory', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const threadId = 'thread-with-project';
    const projectPath = 'D:/work/payment-service';
    await app.stores.threadStore.create({ id: threadId, projectPath });

    await postMessage(app, threadId);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.workingDirectory).toBe(projectPath);
  });

  it('falls back to defaultWorkspace when the thread has no projectPath', async () => {
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    const threadId = 'thread-no-project';
    // Thread auto-created on first message — it carries no projectPath.
    await postMessage(app, threadId);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.workingDirectory).toBe(defaultWorkspace);
  });

  it('prefers thread.projectPath over defaultWorkspace when both are set', async () => {
    const defaultWorkspace = 'D:/work/shared-sandbox';
    const { app, fake } = appWithFake({ defaultWorkspace });
    cleanups.push(app.close);

    const threadId = 'thread-both';
    const projectPath = 'D:/work/auth-service';
    await app.stores.threadStore.create({ id: threadId, projectPath });

    await postMessage(app, threadId);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.workingDirectory).toBe(projectPath);
  });

  it('NO REGRESSION: workingDirectory stays undefined with neither projectPath nor defaultWorkspace', async () => {
    const { app, fake } = appWithFake();
    cleanups.push(app.close);

    const threadId = 'thread-bare';
    await postMessage(app, threadId);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.workingDirectory).toBeUndefined();
  });
});
