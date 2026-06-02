// M8 QA — callback-routes edge + adversarial coverage (independently authored).
//
// Attacks read_file's sandbox (path traversal via ../, absolute paths, missing
// file → 404, oversize → 413), post_message idempotent dedup + body validation,
// and evidence_search query validation + limit bounds. Every route is hit
// THROUGH the real auth preHandler (a live invocation minted by the app's own
// registry) so we drive the production code paths, not a mock.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { INVOCATION_ID_HEADER, CALLBACK_TOKEN_HEADER } from '@choco/api/routes/callback-auth';

const CLAUDE = createAgentId('claude-opus');

interface LiveCb {
  readonly app: BuiltApp;
  readonly headers: Record<string, string>;
  readonly threadId: string;
  readonly fileRoot: string;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Build an app with a temp sandbox root + a live invocation for the callbacks. */
async function liveCallbackApp(): Promise<LiveCb> {
  const fileRoot = mkdtempSync(join(tmpdir(), 'm8-qa-root-'));
  cleanups.push(() => rmSync(fileRoot, { recursive: true, force: true }));
  // A real file inside the sandbox to read on the happy edges.
  writeFileSync(join(fileRoot, 'NOTES.md'), '# 评审纪要\n决定使用 SQLite + sqlite-vec。\n', 'utf8');

  const db = new Database(':memory:');
  const app = buildApp({ db, fileRoot });
  cleanups.push(app.close);
  const threadId = 'thread-cb-edge';
  await app.stores.threadStore.ensureThread(threadId, 'callback edge');
  const rec = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
  return {
    app,
    headers: { [INVOCATION_ID_HEADER]: rec.invocationId, [CALLBACK_TOKEN_HEADER]: rec.callbackToken },
    threadId,
    fileRoot,
  };
}

describe('read_file sandbox (adversarial)', () => {
  it('rejects a ../ traversal escaping the sandbox root with 403', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers,
      payload: { path: '../../../../../../etc/passwd' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('path_outside_root');
  });

  it('rejects an absolute path pointing outside the sandbox with 403', async () => {
    const { app, headers } = await liveCallbackApp();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers,
      payload: { path: outside },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 (not 500, no path/errno leak) for a missing file inside the sandbox', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers,
      payload: { path: 'does-not-exist-2026.txt' },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json<Record<string, unknown>>();
    expect(body.error).toBe('file_not_found');
    // Must not leak an absolute path or errno detail.
    expect(JSON.stringify(body)).not.toContain('ENOENT');
  });

  it('reads a real file that legitimately lives inside the sandbox (sandbox is not a blanket deny)', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers,
      payload: { path: 'NOTES.md' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ content: string }>().content).toContain('SQLite');
  });

  it('requires auth: an unauthenticated read_file is 401 BEFORE any path logic runs', async () => {
    const { app } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      // no auth headers
      payload: { path: 'NOTES.md' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an oversize file (> 256 KiB default cap) with 413', async () => {
    const { app, headers, fileRoot } = await liveCallbackApp();
    // 300 KiB of real-ish log content, comfortably over the 256 KiB cap.
    const big = 'INFO orchestrator wave5 dispatch M8 ok\n'.repeat(8000);
    writeFileSync(join(fileRoot, 'huge.log'), big, 'utf8');
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers,
      payload: { path: 'huge.log' },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: string }>().error).toBe('file_too_large');
  });
});

describe('post_message idempotent dedup + validation (edge/adversarial)', () => {
  it('dedups a retried clientMessageId: same id twice → exactly one persisted message', async () => {
    const { app, headers, threadId } = await liveCallbackApp();
    const payload = { content: 'A2A 进度：架构草案已提交评审。', clientMessageId: 'mcp-retry-7f3a' };

    const first = await app.api.inject({ method: 'POST', url: '/api/callback/post_message', headers, payload });
    expect(first.statusCode).toBe(201);

    const second = await app.api.inject({ method: 'POST', url: '/api/callback/post_message', headers, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);

    const stored = await app.stores.messageStore.getByThread(threadId);
    const callbackMsgs = stored.filter((m) => m.origin === 'callback');
    expect(callbackMsgs).toHaveLength(1);
  });

  it('rejects an empty content body with 400 (min(1) boundary)', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers,
      payload: { content: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown extra field via the strict schema (no smuggled fields)', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers,
      payload: { content: '正常内容', origin: 'system', userId: 'root' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('a wrong token is 401 AND nothing is persisted (auth blocks the write, not just the response)', async () => {
    const { app, threadId } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: { 'x-invocation-id': 'inv-forged', 'x-callback-token': 'forged-token' },
      payload: { content: '攻击者试图伪造写入' },
    });
    expect(res.statusCode).toBe(401);
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.filter((m) => m.origin === 'callback')).toHaveLength(0);
  });

  it('concurrent retries with the SAME clientMessageId persist exactly one message (dedup race)', async () => {
    const { app, headers, threadId } = await liveCallbackApp();
    const payload = { content: 'A2A 进度：评估完成。', clientMessageId: 'mcp-race-c91e' };
    const results = await Promise.all([
      app.api.inject({ method: 'POST', url: '/api/callback/post_message', headers, payload }),
      app.api.inject({ method: 'POST', url: '/api/callback/post_message', headers, payload }),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    // One wins (201), one dedups (200).
    expect(codes).toEqual([200, 201]);
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.filter((m) => m.origin === 'callback')).toHaveLength(1);
  });
});

describe('evidence_search callback validation (edge)', () => {
  it('rejects an empty query with 400 (query min length 1)', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_search',
      headers,
      payload: { query: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-positive limit (0) with 400 (positive-int bound)', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_search',
      headers,
      payload: { query: 'Fastify 选型', limit: 0 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns an empty result set (200, fail-open) for a query that matches nothing', async () => {
    const { app, headers } = await liveCallbackApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_search',
      headers,
      payload: { query: '完全不存在的检索词zzz量子折跃' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>().items).toEqual([]);
  });
});
