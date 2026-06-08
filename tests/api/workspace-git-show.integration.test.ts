// workspace-git-show (integration) — drives GET /api/workspace/git-show against a
// REAL git repo (temp `git init` + a real commit) through the DEFAULT git runner,
// so it proves the real path: `git show --stat` output → split off the message
// block → parseGitShow. The route unit test uses a fake runner with canned output;
// THIS one verifies our \n\n-split assumption holds on real git's actual format.

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A real git repo with one commit that adds two files; returns its HEAD hash. */
function makeGitRepo(): { root: string; hash: string } {
  const root = mkdtempSync(join(tmpdir(), 'choco-gitshow-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git(['init', '-q']);
  writeFileSync(join(root, 'a.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, 'b.md'), '# hi\n');
  git(['add', '.']);
  // -c flags so the test never depends on the machine's global git identity.
  git(['-c', 'user.email=t@t.dev', '-c', 'user.name=tester', 'commit', '-qm', 'add a.ts + b.md']);
  const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  return { root, hash };
}

function makeApp(root: string): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, fileRoot: root }); // default (real) git runner
  cleanups.push(app.close);
  return app;
}

describe('GET /api/workspace/git-show against a real git repo', () => {
  it('parses real `git show --stat` output into the commit changed-file list', async () => {
    const { root, hash } = makeGitRepo();
    const app = makeApp(root);
    const res = await app.api.inject({ method: 'GET', url: `/api/workspace/git-show?hash=${hash}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: { path: string; summary: string }[]; gitAvailable: boolean }>();
    expect(body.gitAvailable).toBe(true);
    const paths = body.files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.ts', 'b.md']);
    // The summary column carries the per-file insertion/deletion bar.
    expect(body.files.every((f) => f.summary.length > 0)).toBe(true);
  });

  it('reports gitAvailable:false for a non-existent commit hash (honest, not faked)', async () => {
    const { root } = makeGitRepo();
    const app = makeApp(root);
    const res = await app.api.inject({
      method: 'GET',
      url: '/api/workspace/git-show?hash=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ files: unknown[]; gitAvailable: boolean }>();
    expect(body.gitAvailable).toBe(false);
    expect(body.files).toEqual([]);
  });
});
