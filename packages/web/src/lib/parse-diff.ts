// parse-diff — turn a unified `git diff` string into per-file hunks for rendering
// in the 变更 view. Ported from Clowder reference/.../workspace/DiffViewer.tsx
// (parseUnifiedDiff), kept as a pure util so it is unit-tested without React.

/** One rendered diff line. */
export interface DiffLine {
  readonly type: 'add' | 'remove' | 'context' | 'meta';
  readonly content: string;
}

/** One file's worth of diff lines (already including its @@ hunk headers as meta). */
export interface FileDiff {
  readonly path: string;
  readonly lines: readonly DiffLine[];
}

/**
 * Parse a unified diff into per-file line lists. Recognizes `diff --git a/x b/y`
 * file boundaries (overridden by the `+++ b/` path so renames resolve to the new
 * name), `@@` hunk headers (kept as `meta`), and +/-/space body lines.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  if (diff.trim().length === 0) return [];
  const files: { path: string; lines: DiffLine[] }[] = [];
  let current: { path: string; lines: DiffLine[] } | null = null;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader !== null) {
      current = { path: gitHeader[2] ?? '', lines: [] };
      files.push(current);
      inHunk = false;
      continue;
    }
    if (current === null) continue;

    if (line.startsWith('+++ b/')) {
      current = { ...current, path: line.slice(6) };
      files[files.length - 1] = current;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    if (line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file')) continue;

    if (line.startsWith('@@')) {
      inHunk = true;
      current.lines.push({ type: 'meta', content: line });
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) current.lines.push({ type: 'add', content: line.slice(1) });
    else if (line.startsWith('-')) current.lines.push({ type: 'remove', content: line.slice(1) });
    else current.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
  }

  return files.map((f) => ({ path: f.path, lines: f.lines }));
}
