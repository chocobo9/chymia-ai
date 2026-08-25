// workspace-file-raw — GET /api/workspace/file/raw streams a workspace MEDIA file
// (image/audio/video) with its real content-type so the preview can render an
// <img>/<video> instead of the binary placeholder. Real fs temp workspace (no
// mocks for the file read). Aligned to Clowder routes/workspace.ts GET /file/raw.
//
// Covers: 200 + content-type + verbatim bytes; non-media 400; path-traversal 403;
// sensitive file 403; missing file 404.

import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** Minimal PNG header + a few bytes — the endpoint keys off the extension, not content. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'choco-raw-'));
  writeFileSync(join(root, 'logo.png'), PNG_BYTES);
  writeFileSync(join(root, 'notes.txt'), 'plain text, not media');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeApp(root: string): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, fileRoot: root });
  cleanups.push(app.close);
  return app;
}

describe('GET /api/workspace/file/raw (media preview)', () => {
  it('streams an image with its real content-type and verbatim bytes', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file/raw?path=logo.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG_BYTES)).toBe(true);
  });

  it('rejects a non-media file (400) — raw serves image/audio/video only', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file/raw?path=notes.txt' });
    expect(res.statusCode).toBe(400);
  });

  it('[security] rejects a path climbing out of the workspace (403)', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file/raw?path=../../etc/x.png' });
    expect(res.statusCode).toBe(403);
  });

  it('[security] rejects a sensitive file before any read (403)', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file/raw?path=.env' });
    expect(res.statusCode).toBe(403);
  });

  it('404 for a missing media file', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file/raw?path=missing.png' });
    expect(res.statusCode).toBe(404);
  });
});
