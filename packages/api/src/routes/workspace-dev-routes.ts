// workspace-dev-routes — the 开发 tab's read-only backend: file tree (文件树),
// git diff (变更), git log + status (Git). Aligned to Clowder routes/workspace.ts
// (tree + diff) + routes/workspace-git.ts (git-log/status).
//
// choco port: a SINGLE workspace root (the server's fileRoot, = CHOCO_WORKSPACE /
// cwd), NOT Clowder's multi-worktree model (no worktreeId / getWorktreeRoot /
// linked-roots / worktrees / git-health / git-show — YAGNI for one workspace).
// Tree paths go through the SAME resolvePathInRoot sandbox the reveal/file routes
// use; git runs through the injected GitRunner seam. Terminal is a separate
// follow-up (node-pty), deliberately not here.

import { readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolvePathInRoot } from '@choco/api/infrastructure/path-sandbox';
import {
  type GitRunner,
  parseGitLog,
  parseGitStatus,
  parseChangedFiles,
} from '@choco/api/infrastructure/git-cli';

/** Directories never listed in the tree (noise / not source). */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
/** Cap on entries returned for one directory listing (a huge dir is truncated, not unbounded). */
const MAX_TREE_ENTRIES = 1000;
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
/** Untracked porcelain status code. */
const UNTRACKED = '??';

export interface WorkspaceDevRoutesOptions {
  /** Workspace root the tree + git operate on (the agent workspace). */
  readonly fileRoot: string;
  /** Injectable git runner (default: real execFile; tests inject canned output). */
  readonly gitRunner: GitRunner;
}

interface TreeEntry {
  readonly name: string;
  readonly type: 'directory' | 'file';
  readonly path: string;
}

const TreeQuerySchema = z.object({ path: z.string().optional() });
const LogQuerySchema = z.object({ limit: z.string().optional() });
const DiffQuerySchema = z.object({ path: z.string().optional() });

/** Workspace-root-relative path with forward slashes (stable across win32). */
function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

/** Register the read-only 开发-tab routes (tree / diff / git-log / git-status). */
export function registerWorkspaceDevRoutes(
  app: FastifyInstance,
  options: WorkspaceDevRoutesOptions,
): void {
  const fileRoot = resolve(options.fileRoot);
  const { gitRunner } = options;

  // GET /api/workspace/tree?path= — ONE directory level (frontend lazy-expands).
  app.get('/api/workspace/tree', async (request, reply) => {
    const q = TreeQuerySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const subpath = q.data.path ?? '';
    const target = subpath.length > 0 ? resolvePathInRoot(fileRoot, subpath) : fileRoot;
    if (target === null) return reply.code(403).send({ error: 'path_outside_root' });

    let dirents;
    try {
      dirents = await readdir(target, { withFileTypes: true });
    } catch {
      return reply.code(404).send({ error: 'not_found' });
    }

    const entries: TreeEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.') && d.name !== '.claude') continue; // hide dotfiles (keep .claude)
      if (SKIP_DIRS.has(d.name)) continue;
      entries.push({
        name: d.name,
        type: d.isDirectory() ? 'directory' : 'file',
        path: toRel(fileRoot, resolve(target, d.name)),
      });
      if (entries.length >= MAX_TREE_ENTRIES) break;
    }
    // Directories first, then alphabetical (matches Clowder buildTree ordering).
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return reply.send({ root: subpath.length > 0 ? subpath : '.', entries });
  });

  // GET /api/workspace/git-log?limit= — recent commits.
  app.get('/api/workspace/git-log', async (request, reply) => {
    const q = LogQuerySchema.safeParse(request.query);
    const requested = q.success ? Number(q.data.limit) : NaN;
    const n = Math.min(Math.max(1, Number.isFinite(requested) ? requested : DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
    const r = await gitRunner(['log', '-n', String(n), '--pretty=format:%H%x00%an%x00%aI%x00%s'], fileRoot);
    // Non-zero exit = not a git repo / git unavailable. Honest: empty + a flag,
    // never a fabricated history.
    if (r.code !== 0) return reply.send({ commits: [], gitAvailable: false });
    return reply.send({ commits: parseGitLog(r.stdout), gitAvailable: true });
  });

  // GET /api/workspace/git-status — working tree state + current branch.
  app.get('/api/workspace/git-status', async (_request, reply) => {
    const [status, branch] = await Promise.all([
      gitRunner(['status', '--porcelain', '-uall'], fileRoot),
      gitRunner(['branch', '--show-current'], fileRoot),
    ]);
    if (status.code !== 0) {
      return reply.send({ branch: '', staged: [], unstaged: [], untracked: [], gitAvailable: false });
    }
    return reply.send({ branch: branch.stdout.trim(), ...parseGitStatus(status.stdout), gitAvailable: true });
  });

  // GET /api/workspace/diff?path= — changed-file list + unified diff (all, or one file).
  app.get('/api/workspace/diff', async (request, reply) => {
    const q = DiffQuerySchema.safeParse(request.query);
    const only = q.success ? q.data.path : undefined;

    const status = await gitRunner(['status', '--porcelain', '-uall'], fileRoot);
    if (status.code !== 0) return reply.send({ changedFiles: [], diff: '', gitAvailable: false });

    const changedFiles = parseChangedFiles(status.stdout);
    const allowed = changedFiles.map((f) => f.path);

    // Single-file filter: must be inside the sandbox AND an actually-changed file
    // (P0: never diff an arbitrary/denylisted path).
    let pathspec = allowed;
    if (only !== undefined) {
      if (resolvePathInRoot(fileRoot, only) === null) return reply.code(403).send({ error: 'path_outside_root' });
      if (!allowed.includes(only)) return reply.send({ changedFiles, diff: '', gitAvailable: true });
      pathspec = [only];
    }

    let diff = '';
    const untrackedSet = new Set(changedFiles.filter((f) => f.status === UNTRACKED).map((f) => f.path));
    const tracked = pathspec.filter((p) => !untrackedSet.has(p));
    if (tracked.length > 0) {
      const r = await gitRunner(['diff', 'HEAD', '--unified=3', '--no-color', '--', ...tracked], fileRoot);
      if (r.code === 0) {
        diff += r.stdout;
      } else {
        // No HEAD yet (initial commit) → staged diff fallback.
        const f = await gitRunner(['diff', '--cached', '--unified=3', '--no-color', '--', ...tracked], fileRoot);
        diff += f.stdout;
      }
    }
    // Untracked files aren't in `diff HEAD` — synthesize via --no-index (exits 1
    // with the diff on stdout, which the runner surfaces without rejecting).
    for (const path of pathspec.filter((p) => untrackedSet.has(p))) {
      const r = await gitRunner(['diff', '--no-index', '--unified=3', '--no-color', '--', '/dev/null', path], fileRoot);
      diff += r.stdout;
    }
    return reply.send({ changedFiles, diff, gitAvailable: true });
  });
}
