import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import type { GitRunner } from '@choco/api/infrastructure/git-cli';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'choco-ws-align-'));
  writeFileSync(join(root, 'README.md'), '# choco\n');
  writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const fakeGit: GitRunner = (args) => {
  const sub = args.join(' ');
  if (sub.startsWith('branch --show-current')) {
    return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 });
  }
  if (sub.startsWith('status --porcelain')) {
    return Promise.resolve({ stdout: '', stderr: '', code: 0 });
  }
  return Promise.resolve({ stdout: '', stderr: '', code: 0 });
};

function makeApp(root: string): BuiltApp {
  const app = buildApp({ db: new Database(':memory:'), fileRoot: root, gitRunner: fakeGit });
  cleanups.push(app.close);
  return app;
}

describe('workspace alignment routes', () => {
  it('reports the current workspace root and git status', async () => {
    const root = makeWorkspace();
    const app = makeApp(root);

    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/info' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      root,
      trusted: false,
      rootSource: 'fileRoot',
      gitAvailable: true,
      branch: 'main',
    });
  });

  it('returns file metadata with preview content', async () => {
    const app = makeApp(makeWorkspace());

    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/file?path=README.md' });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      path: string;
      content: string;
      size: number;
      sha256: string;
      mime: string;
      truncated: boolean;
      binary: boolean;
    }>();
    expect(body).toMatchObject({
      path: 'README.md',
      content: '# choco\n',
      size: 8,
      mime: 'text/markdown',
      truncated: false,
      binary: false,
    });
    expect(body.sha256).toHaveLength(64);
  });

  it('searches filenames and text content inside the workspace', async () => {
    const app = makeApp(makeWorkspace());

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/workspace/search',
      payload: { query: 'export', type: 'all' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ results: { path: string; line: number; content: string; matchType: string }[] }>();
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/index.ts',
          line: 1,
          content: 'export const x = 1;',
          matchType: 'content',
        }),
      ]),
    );
  });

  it('[security] refuses sensitive file reads and omits them from search', async () => {
    const app = makeApp(makeWorkspace());

    const readRes = await app.api.inject({ method: 'GET', url: '/api/workspace/file?path=.env' });
    expect(readRes.statusCode).toBe(403);

    const searchRes = await app.api.inject({
      method: 'POST',
      url: '/api/workspace/search',
      payload: { query: 'TOKEN', type: 'all' },
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json<{ results: { path: string }[] }>().results.map((r) => r.path)).not.toContain('.env');
  });

  it('uploads a base64 file into a workspace directory', async () => {
    const root = makeWorkspace();
    const app = makeApp(root);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/workspace/upload',
      payload: {
        directory: 'src',
        filename: 'note.txt',
        contentBase64: Buffer.from('hello workspace\n', 'utf8').toString('base64'),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, path: 'src/note.txt', size: 16 });
    expect(existsSync(join(root, 'src', 'note.txt'))).toBe(true);
    expect(readFileSync(join(root, 'src', 'note.txt'), 'utf8')).toBe('hello workspace\n');
  });

  it('[security] refuses upload paths outside the workspace', async () => {
    const app = makeApp(makeWorkspace());

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/workspace/upload',
      payload: {
        directory: '..',
        filename: 'escape.txt',
        contentBase64: Buffer.from('nope').toString('base64'),
      },
    });

    expect(res.statusCode).toBe(403);
  });
});
