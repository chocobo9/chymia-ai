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

import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolvePathInRoot } from '@choco/api/infrastructure/path-sandbox';
import {
  isSafeWorkspaceFile,
  isSearchableTextPath,
  isSensitiveWorkspacePath,
  toWorkspaceRelative,
} from '@choco/api/infrastructure/workspace-security';
import { WorkspaceTrustStore, resolveTrustStorePath } from '@choco/api/runtime/workspace-trust';
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
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
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

interface WorkspaceSearchResult {
  readonly path: string;
  readonly line: number;
  readonly content: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
  readonly matchType: 'filename' | 'content';
}

const TreeQuerySchema = z.object({ path: z.string().optional() });
const LogQuerySchema = z.object({ limit: z.string().optional() });
const DiffQuerySchema = z.object({ path: z.string().optional() });
const SearchBodySchema = z.object({
  query: z.string().trim().min(1).max(200),
  type: z.enum(['filename', 'content', 'all']).optional(),
  path: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
});

/** Register the read-only 开发-tab routes (tree / diff / git-log / git-status). */
export function registerWorkspaceDevRoutes(
  app: FastifyInstance,
  options: WorkspaceDevRoutesOptions,
): void {
  const fileRoot = resolve(options.fileRoot);
  const { gitRunner } = options;
  const trustStore = new WorkspaceTrustStore(resolveTrustStorePath());

  app.get('/api/workspace/info', async (_request, reply) => {
    const [branch, status] = await Promise.all([
      gitRunner(['branch', '--show-current'], fileRoot),
      gitRunner(['status', '--porcelain', '-uall'], fileRoot),
    ]);
    return reply.send({
      root: fileRoot,
      trusted: trustStore.isTrusted(fileRoot),
      rootSource: 'fileRoot',
      gitAvailable: status.code === 0,
      branch: branch.code === 0 ? branch.stdout.trim() : '',
    });
  });

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
      const abs = resolve(target, d.name);
      const rel = toWorkspaceRelative(fileRoot, abs);
      if (isSensitiveWorkspacePath(rel)) continue;
      entries.push({
        name: d.name,
        type: d.isDirectory() ? 'directory' : 'file',
        path: rel,
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
  app.post('/api/workspace/search', async (request, reply) => {
    const body = SearchBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });

    const query = body.data.query.toLowerCase();
    const type = body.data.type ?? 'all';
    const limit = body.data.limit ?? MAX_SEARCH_RESULTS;
    const start =
      body.data.path !== undefined && body.data.path.length > 0
        ? resolvePathInRoot(fileRoot, body.data.path)
        : fileRoot;
    if (start === null) return reply.code(403).send({ error: 'path_outside_root' });

    const results: WorkspaceSearchResult[] = [];

    async function visit(dir: string): Promise<void> {
      if (results.length >= limit) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (results.length >= limit) return;
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
        if (SKIP_DIRS.has(entry.name)) continue;

        const abs = resolve(dir, entry.name);
        const rel = toWorkspaceRelative(fileRoot, abs);
        if (isSensitiveWorkspacePath(rel)) continue;

        if (entry.isDirectory()) {
          await visit(abs);
          continue;
        }
        if (!entry.isFile() || !isSafeWorkspaceFile(fileRoot, abs)) continue;

        if ((type === 'filename' || type === 'all') && entry.name.toLowerCase().includes(query)) {
          results.push({
            path: rel,
            line: 0,
            content: entry.name,
            contextBefore: [],
            contextAfter: [],
            matchType: 'filename',
          });
          if (results.length >= limit) return;
        }

        if ((type === 'content' || type === 'all') && isSearchableTextPath(rel)) {
          let buffer: Buffer;
          try {
            buffer = await readFile(abs);
          } catch {
            continue;
          }
          if (buffer.byteLength > MAX_SEARCH_FILE_BYTES) continue;
          const lines = buffer.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i] ?? '';
            if (!line.toLowerCase().includes(query)) continue;
            results.push({
              path: rel,
              line: i + 1,
              content: line,
              contextBefore: lines.slice(Math.max(0, i - 2), i),
              contextAfter: lines.slice(i + 1, i + 3),
              matchType: 'content',
            });
            if (results.length >= limit) return;
          }
        }
      }
    }

    await visit(start);
    return reply.send({ results });
  });

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
