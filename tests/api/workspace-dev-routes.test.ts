// workspace-dev-routes — the 开发 tab's read-only backend: file tree, git diff
// (变更), git log + status (Git). Aligned to Clowder routes/workspace.ts (tree +
// diff) + routes/workspace-git.ts (git-log/status). choco port: single workspace
// root (fileRoot), no worktreeId; git runs through an injectable GitRunner seam so
// this test needs NO real git repo — canned git output is injected.
//
// SYMPTOM: the 开发 tab was an honest placeholder — GET /api/workspace/tree /diff
// /git-log /git-status all 404'd. RED: 404. GREEN: real fs tree (sandboxed) + the
// parsed git surface.

import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import type { GitRunner } from '@choco/api/infrastructure/git-cli';

/** git's NUL field separator (--pretty=format:%x00), kept as an escape not a literal byte. */
const NUL = String.fromCharCode(0);

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A temp workspace: README.md + src/index.ts + a dotfile + node_modules (skipped). */
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'choco-ws-'));
  writeFileSync(join(root, 'README.md'), '# choco\n');
  writeFileSync(join(root, '.secret'), 'nope');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'junk.js'), '//');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Canned git output keyed by subcommand — no real git is run. */
const fakeGit: GitRunner = (args) => {
  const sub = args.join(' ');
  if (sub.startsWith('status --porcelain')) {
    return Promise.resolve({ stdout: ' M src/index.ts\nA  added.ts\n?? new.txt\n', stderr: '', code: 0 });
  }
  if (sub.startsWith('branch --show-current')) {
    return Promise.resolve({ stdout: 'main\n', stderr: '', code: 0 });
  }
  if (sub.startsWith('log')) {
    const line = ['abc123def456', '用户', '2026-06-05T10:00:00+08:00', '修任务 tab'].join(NUL);
    return Promise.resolve({ stdout: `${line}\n`, stderr: '', code: 0 });
  }
  if (sub.startsWith('diff')) {
    return Promise.resolve({
      stdout:
        'diff --git a/src/index.ts b/src/index.ts\n' +
        '--- a/src/index.ts\n+++ b/src/index.ts\n' +
        '@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n',
      stderr: '',
      code: 0,
    });
  }
  if (sub.startsWith('show')) {
    // `git show --stat <hash>`: commit header, blank, message, blank, the stat block.
    return Promise.resolve({
      stdout:
        'commit abc123def456\nAuthor: 铲屎官 <x@y.z>\nDate:   Fri Jun 5 18:00:00 2026\n\n' +
        '    修任务 tab\n\n' +
        ' src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n',
      stderr: '',
      code: 0,
    });
  }
  return Promise.resolve({ stdout: '', stderr: '', code: 0 });
};

function makeApp(root: string): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, fileRoot: root, gitRunner: fakeGit });
  cleanups.push(app.close);
  return app;
}

describe('GET /api/workspace/tree (文件树)', () => {
  it('lists a directory, directories first, hiding dotfiles + node_modules', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/tree' });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json<{ entries: { name: string; type: string; path: string }[] }>();
    const names = entries.map((e) => e.name);
    expect(names).toEqual(['src', 'README.md']); // dir first, then file
    expect(names).not.toContain('.secret');
    expect(names).not.toContain('node_modules');
  });

  it('lists a subdirectory via ?path=', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/tree?path=src' });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json<{ entries: { name: string }[] }>();
    expect(entries.map((e) => e.name)).toEqual(['index.ts']);
  });

  it('[security] rejects a path climbing out of the workspace (403)', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/tree?path=../../etc' });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/workspace/git-log + git-status (Git)', () => {
  it('git-log parses the NUL-delimited commit list', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/git-log' });
    expect(res.statusCode).toBe(200);
    const { commits } = res.json<{ commits: { hash: string; short: string; author: string; subject: string }[] }>();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ hash: 'abc123def456', short: 'abc123de', author: '用户', subject: '修任务 tab' });
  });

  it('git-status classifies staged / unstaged / untracked + reports the branch', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/git-status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      branch: string;
      staged: { path: string }[];
      unstaged: { path: string }[];
      untracked: { path: string }[];
    }>();
    expect(body.branch).toBe('main');
    expect(body.unstaged.map((f) => f.path)).toContain('src/index.ts');
    expect(body.staged.map((f) => f.path)).toContain('added.ts');
    expect(body.untracked.map((f) => f.path)).toContain('new.txt');
  });
});

describe('GET /api/workspace/git-show (提交详情下钻)', () => {
  it('parses `git show --stat` into the commit changed-file list', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/git-show?hash=abc123def456' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ hash: string; files: { path: string; summary: string }[]; gitAvailable: boolean }>();
    expect(body.gitAvailable).toBe(true);
    expect(body.files).toEqual([{ path: 'src/index.ts', summary: '2 +-' }]);
  });

  it('[security] rejects a non-hex hash (400) — no flag/path can be smuggled into git', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/git-show?hash=--upload-pack' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/workspace/diff (变更)', () => {
  it('returns the changed-file list and the unified diff text', async () => {
    const app = makeApp(makeWorkspace());
    const res = await app.api.inject({ method: 'GET', url: '/api/workspace/diff' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ changedFiles: { status: string; path: string }[]; diff: string }>();
    expect(body.changedFiles.map((f) => f.path)).toContain('src/index.ts');
    expect(body.diff).toContain('export const x = 2;');
  });
});
