// git-cli — the injectable git-command seam + pure output parsers for the 开发
// tab's read-only Git surface (变更 diff / Git log+status).
//
// Aligned to Clowder routes/workspace-git.ts (parseGitLog/parseGitStatus) +
// routes/workspace.ts (changed-file parse). The runner is a SEAM (like os-open's
// OsOpener): the default shells out via execFile with ARRAY args (never a shell
// string — no injection surface); route tests inject a fake that returns canned
// git output, so they need NO real git repo and never spawn git.

import { execFile } from 'node:child_process';

/** One git invocation's result. `code` is the process exit code (git uses nonzero meaningfully). */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** The injectable git runner: run `git <args>` in `cwd`, resolve with its output. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>;

/** Bound on git stdout we buffer (a large diff/status is capped, not unbounded). */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Per-command timeout so a wedged git can't hang the request. */
const GIT_TIMEOUT_MS = 10_000;

/**
 * Default runner — execFile('git', args, { cwd }). NEVER rejects on a nonzero git
 * exit (git uses exit 1 meaningfully, e.g. `diff --no-index` when files differ);
 * it resolves with the exit `code` so callers branch on it. A spawn failure (git
 * not installed) resolves code=127 with the message in stderr.
 */
export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ stdout, stderr, code: 0 });
          return;
        }
        const code = typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 127;
        resolvePromise({ stdout: stdout ?? '', stderr: stderr || error.message, code });
      },
    );
  });

// ── Pure parsers (unit-tested directly) ──────────────────────────────

/** One commit row from `git log --pretty=format:%H%x00%an%x00%aI%x00%s`. */
export interface GitCommit {
  readonly hash: string;
  readonly short: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

/** Parse NUL-delimited git-log output (one commit per line). */
export function parseGitLog(stdout: string): GitCommit[] {
  if (stdout.trim().length === 0) return [];
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [hash = '', author = '', date = '', ...subjectParts] = line.split('\0');
      return { hash, short: hash.slice(0, 8), author, date, subject: subjectParts.join('\0') };
    });
}

/** A status entry: the git porcelain status code + the file path. */
export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

export interface GitStatusResult {
  readonly staged: GitStatusEntry[];
  readonly unstaged: GitStatusEntry[];
  readonly untracked: GitStatusEntry[];
}

/** Classify one porcelain line by its X (staged) / Y (unstaged) columns. */
function classifyStatusLine(line: string): { bucket: keyof GitStatusResult; entry: GitStatusEntry }[] {
  if (line.length < 4) return [];
  const x = line[0] ?? ' ';
  const y = line[1] ?? ' ';
  const filePath = line.slice(3);
  if (x === '?' && y === '?') return [{ bucket: 'untracked', entry: { status: '??', path: filePath } }];
  const out: { bucket: keyof GitStatusResult; entry: GitStatusEntry }[] = [];
  if (x !== ' ' && x !== '?') out.push({ bucket: 'staged', entry: { status: x, path: filePath } });
  if (y !== ' ' && y !== '?') out.push({ bucket: 'unstaged', entry: { status: y, path: filePath } });
  return out;
}

/** Parse `git status --porcelain -uall` into staged/unstaged/untracked buckets. */
export function parseGitStatus(stdout: string): GitStatusResult {
  const result: GitStatusResult = { staged: [], unstaged: [], untracked: [] };
  // Split on newlines WITHOUT trimming — a line's leading column (e.g. " M path")
  // is significant; a whole-string .trim() would shift the first line's path.
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    for (const { bucket, entry } of classifyStatusLine(line)) result[bucket].push(entry);
  }
  return result;
}

/** A changed file for the 变更 list: 2-char status + path. */
export interface ChangedFile {
  readonly status: string;
  readonly path: string;
}

/**
 * Parse `git status --porcelain -uall` into a flat changed-file list (for the diff
 * pathspec). Rename/copy lines ("old -> new") collapse to the new path. Denylisted
 * paths (.env/.key/.pem, .git/node_modules) are dropped — they must never reach the
 * diff pathspec (P0: a no-pathspec `git diff` would leak secret file content).
 */
export function parseChangedFiles(stdout: string): ChangedFile[] {
  // No whole-string .trim() — the first line's leading status column must survive
  // (" M path" → status 'M', path 'path'; trimming would drop the leading space).
  return stdout
    .split('\n')
    .filter((l) => l.length >= 4)
    .map((line) => {
      const status = line.slice(0, 2).trim();
      let path = line.slice(3);
      if ((status.startsWith('R') || status.startsWith('C')) && path.includes(' -> ')) {
        path = path.slice(path.indexOf(' -> ') + 4);
      }
      return { status, path };
    })
    .filter((f) => !isDenylistedPath(f.path));
}

/** Path segments / suffixes that must never be read or diffed (secret leakage / noise). */
const DENYLIST_SUFFIXES = ['.env', '.key', '.pem', '.p12', '.pfx'];
const DENYLIST_SEGMENTS = new Set(['.git', 'node_modules']);

/** True if a relative path is a secret/noise path that must be excluded from diff/read. */
export function isDenylistedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (DENYLIST_SUFFIXES.some((s) => normalized.endsWith(s)) || normalized.includes('/.env')) {
    return true;
  }
  return normalized.split('/').some((seg) => DENYLIST_SEGMENTS.has(seg));
}
