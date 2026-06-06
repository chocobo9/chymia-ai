// git-cli parsers — pure functions over canned git output. These lock in the
// leading-column fix (a whole-string .trim() shifts the first porcelain line's
// path) + rename normalization + the secret-file denylist that keeps .env/.key
// out of any diff pathspec.

import { describe, it, expect } from 'vitest';
import {
  parseGitLog,
  parseGitStatus,
  parseChangedFiles,
  isDenylistedPath,
} from '@choco/api/infrastructure/git-cli';

/** The NUL field separator git emits for `--pretty=format:%x00` (kept as an escape, not a literal byte). */
const NUL = String.fromCharCode(0);

describe('parseGitLog', () => {
  it('splits NUL-delimited rows into hash/short/author/date/subject', () => {
    const stdout = ['abc123def456ff', 'chocobo9', '2026-06-05T10:00:00+08:00', '修任务 tab'].join(NUL) + '\n';
    const [c] = parseGitLog(stdout);
    expect(c).toMatchObject({ hash: 'abc123def456ff', short: 'abc123de', author: 'chocobo9', subject: '修任务 tab' });
  });

  it('returns [] for empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('parseGitStatus', () => {
  it('classifies the FIRST line correctly even when it has a leading column space', () => {
    // ' M ...' (unstaged modify) as the FIRST line is the case a whole-string
    // trim() would corrupt (dropping the leading space → path off by one).
    const stdout = ' M src/index.ts\nA  added.ts\n?? new.txt\n';
    const r = parseGitStatus(stdout);
    expect(r.unstaged).toEqual([{ status: 'M', path: 'src/index.ts' }]);
    expect(r.staged).toEqual([{ status: 'A', path: 'added.ts' }]);
    expect(r.untracked).toEqual([{ status: '??', path: 'new.txt' }]);
  });

  it('reports a file modified both staged and unstaged in both buckets', () => {
    const r = parseGitStatus('MM both.ts\n');
    expect(r.staged).toEqual([{ status: 'M', path: 'both.ts' }]);
    expect(r.unstaged).toEqual([{ status: 'M', path: 'both.ts' }]);
  });
});

describe('parseChangedFiles', () => {
  it('keeps the leading-space first line and normalizes a rename to the new path', () => {
    const stdout = ' M src/a.ts\nR  old.ts -> new.ts\n';
    const files = parseChangedFiles(stdout);
    expect(files).toContainEqual({ status: 'M', path: 'src/a.ts' });
    expect(files.map((f) => f.path)).toContain('new.ts');
    expect(files.map((f) => f.path)).not.toContain('old.ts');
  });

  it('drops denylisted secret files so they never reach a diff pathspec', () => {
    const files = parseChangedFiles(' M .env\nA  config/app.key\n M src/ok.ts\n');
    expect(files.map((f) => f.path)).toEqual(['src/ok.ts']);
  });
});

describe('isDenylistedPath', () => {
  it('flags secret suffixes, nested .env, and node_modules / .git segments', () => {
    expect(isDenylistedPath('.env')).toBe(true);
    expect(isDenylistedPath('packages/api/.env.local')).toBe(true);
    expect(isDenylistedPath('certs/server.pem')).toBe(true);
    expect(isDenylistedPath('node_modules/foo/index.js')).toBe(true);
    expect(isDenylistedPath('.git/config')).toBe(true);
    expect(isDenylistedPath('src/index.ts')).toBe(false);
  });
});
