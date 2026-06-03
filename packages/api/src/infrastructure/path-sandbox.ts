// path-sandbox — the single path-traversal guard shared by every route that
// resolves a caller-supplied path against a sandbox root (the read_file /
// search_files callbacks AND the workspace reveal/open route). Extracted so the
// guard lives in exactly one place (CLAUDE.md DRY: no copy-pasted security checks).

import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Resolve `requested` against `root`, returning the absolute path ONLY if it
 * stays inside `root`. Returns null on any traversal escape (`..` climbing out,
 * or an absolute path pointing outside the sandbox). An empty relative result
 * means `requested` IS `root`, which is allowed.
 */
export function resolvePathInRoot(root: string, requested: string): string | null {
  const candidate = isAbsolute(requested) ? requested : resolve(root, requested);
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return candidate;
  }
  return null;
}
