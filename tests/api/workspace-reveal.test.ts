// POST /api/workspace/reveal — the browser-initiated "open/reveal a file the
// agent wrote" route. Gates the sandbox guard (no opening files outside the
// workspace), the action dispatch to the injected OS-open seam, and the
// not-found / bad-body / opener-failure paths. The OsOpener is a fake so nothing
// actually launches Explorer/Finder; we assert the resolved ABSOLUTE path + action
// it was handed. Real workspace files (a leetcode viz the dogfooding case wrote).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import type { OpenAction } from '@choco/api/infrastructure/os-open';

/** A recording fake OsOpener: captures every (absPath, action) without touching the OS. */
interface OpenerCall {
  readonly absPath: string;
  readonly action: OpenAction;
}
function makeRecordingOpener(): { calls: OpenerCall[]; opener: (p: string, a: OpenAction) => Promise<void> } {
  const calls: OpenerCall[] = [];
  return {
    calls,
    opener: (absPath, action) => {
      calls.push({ absPath, action });
      return Promise.resolve();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

let workspace: string;
let vizPath: string;
const VIZ_NAME = 'two-sum-viz.html';
const VIZ_HTML = '<!DOCTYPE html>\n<html lang="zh-CN"><head><title>Two Sum 可视化</title></head><body></body></html>\n';

beforeEach(() => {
  // A real temp workspace with a real file the "agent" wrote.
  workspace = mkdtempSync(join(tmpdir(), 'choco-ws-'));
  vizPath = join(workspace, VIZ_NAME);
  writeFileSync(vizPath, VIZ_HTML, 'utf-8');
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
});

/** Build an inject-only app sandboxed to the temp workspace, with a fake opener. */
function appWithOpener(opener: (p: string, a: OpenAction) => Promise<void>): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: {}, fileRoot: workspace, osOpener: opener });
  cleanups.push(() => void app.close());
  return app;
}

async function postReveal(
  app: BuiltApp,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.api.inject({ method: 'POST', url: '/api/workspace/reveal', payload });
  // Every response on this route (200 / 400 / 403 / 404 / 500) carries a JSON body.
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

describe('POST /api/workspace/reveal — happy path', () => {
  it("reveal action hands the file's ABSOLUTE path + 'reveal' to the OS opener (200)", async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status, body } = await postReveal(app, { path: VIZ_NAME, action: 'reveal' });

    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, action: 'reveal' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ absPath: resolve(vizPath), action: 'reveal' });
  });

  it("open action opens the file itself with its default app ('open')", async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status } = await postReveal(app, { path: VIZ_NAME, action: 'open' });

    expect(status).toBe(200);
    expect(calls[0]).toEqual({ absPath: resolve(vizPath), action: 'open' });
  });
});

describe('POST /api/workspace/reveal — edge', () => {
  it("defaults to 'reveal' when action is omitted", async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status, body } = await postReveal(app, { path: VIZ_NAME });

    expect(status).toBe(200);
    expect(body).toMatchObject({ action: 'reveal' });
    expect(calls[0]?.action).toBe('reveal');
  });

  it('resolves a nested workspace-relative path (subdir file) correctly', async () => {
    const sub = join(workspace, 'demos');
    mkdirSync(sub);
    writeFileSync(join(sub, 'sort-viz.html'), VIZ_HTML, 'utf-8');
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status } = await postReveal(app, { path: 'demos/sort-viz.html', action: 'open' });

    expect(status).toBe(200);
    expect(calls[0]?.absPath).toBe(resolve(join(sub, 'sort-viz.html')));
  });

  it('returns 404 (and does NOT call the opener) for a file that does not exist in the workspace', async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status, body } = await postReveal(app, { path: 'nope-not-here.html', action: 'open' });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'file_not_found' });
    expect(calls).toHaveLength(0);
  });

  it('returns 400 for a missing/blank path', async () => {
    const { opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    expect((await postReveal(app, {})).status).toBe(400);
    expect((await postReveal(app, { path: '' })).status).toBe(400);
  });
});

describe('POST /api/workspace/reveal — adversarial (sandbox + failure)', () => {
  it('rejects a `..` traversal escaping the workspace with 403 and NEVER calls the opener', async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    const { status, body } = await postReveal(app, {
      path: '../../../../../../etc/passwd',
      action: 'open',
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'path_outside_root' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an ABSOLUTE path outside the workspace with 403 (agent-supplied path cannot escape)', async () => {
    const { calls, opener } = makeRecordingOpener();
    const app = appWithOpener(opener);

    // A sibling temp dir that is NOT inside the sandbox workspace.
    const outside = mkdtempSync(join(tmpdir(), 'choco-outside-'));
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'top secret', 'utf-8');
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));

    const { status } = await postReveal(app, { path: secret, action: 'open' });

    expect(status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('surfaces an opener failure as 500 (does not hang or leak the error)', async () => {
    const failing = (): Promise<void> => Promise.reject(new Error('explorer missing'));
    const app = appWithOpener(failing);

    const { status, body } = await postReveal(app, { path: VIZ_NAME, action: 'reveal' });

    expect(status).toBe(500);
    expect(body).toMatchObject({ error: 'open_failed' });
  });
});

describe('GET /api/workspace/file — inline preview content', () => {
  function appForPreview(maxPreviewBytes?: number): BuiltApp {
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: {},
      fileRoot: workspace,
      ...(maxPreviewBytes !== undefined ? { maxPreviewBytes } : {}),
    });
    cleanups.push(() => void app.close());
    return app;
  }
  async function getFile(app: BuiltApp, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const url = `/api/workspace/file?path=${encodeURIComponent(path)}`;
    const res = await app.api.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
  }

  it('returns the exact text content of a workspace file (200)', async () => {
    const app = appForPreview();
    const { status, body } = await getFile(app, VIZ_NAME);
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: VIZ_NAME, content: VIZ_HTML });
  });

  it('rejects a `..` traversal escaping the workspace with 403 (cannot read host files)', async () => {
    const app = appForPreview();
    const { status, body } = await getFile(app, '../../../../../../etc/hosts');
    expect(status).toBe(403);
    expect(body).toMatchObject({ error: 'path_outside_root' });
  });

  it('returns 404 for a file that does not exist', async () => {
    const app = appForPreview();
    expect((await getFile(app, 'ghost.html')).status).toBe(404);
  });

  it('returns 400 when the path query is missing', async () => {
    const app = appForPreview();
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 413 when the file exceeds the preview size cap', async () => {
    // A real file just over a tiny injected cap (VIZ_HTML is ~90 bytes).
    const app = appForPreview(16);
    const { status, body } = await getFile(app, VIZ_NAME);
    expect(status).toBe(413);
    expect(body).toMatchObject({ error: 'file_too_large' });
  });
});
