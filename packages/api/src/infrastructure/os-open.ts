// os-open — the OS-level "open this file" / "reveal it in the file manager" seam.
//
// This is how the web UI's diff-block file affordances ("打开" / "所在文件夹")
// actually surface a file the agent just wrote: the browser POSTs the path, the
// API resolves+sandboxes it, then calls this to hand the absolute path to the
// host OS. Mirrors Clowder's POST /api/workspace/reveal (open -R / explorer
// /select, / xdg-open), generalized to also OPEN a file with its default app.
//
// Injected as a seam (OsOpener) so route tests assert "the resolved absolute path
// + action were dispatched" WITHOUT actually launching Explorer/Finder. The real
// implementation uses execFile with ARRAY args (never a shell string) so a path
// is never interpreted by a shell — no injection surface.

import { execFile, type ExecFileException } from 'node:child_process';
import { dirname } from 'node:path';

/** What to do with a file: open it with its default app, or reveal it in the OS file manager. */
export type OpenAction = 'open' | 'reveal';

/** The injectable OS-open seam. Resolves on success, rejects on failure. */
export type OsOpener = (absPath: string, action: OpenAction) => Promise<void>;

/** Run an executable with array args; resolve/reject on completion. */
function run(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, [...args], { timeout: OS_OPEN_TIMEOUT_MS }, (error) => {
      if (error !== null && !isBenignExplorerExit(error)) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

/** Exit-code value an ExecFileException carries for a process that exited nonzero. */
const EXPLORER_BENIGN_EXIT_CODE = 1;

/** Timeout for an OS open/reveal spawn — bounded so a wedged launcher can't hang the request. */
const OS_OPEN_TIMEOUT_MS = 5000;

/**
 * Windows `explorer.exe /select,<path>` (and plain `explorer <path>`) exit with
 * code 1 even on SUCCESS — a long-standing quirk. Treat an explorer exit-1 as
 * benign so a successful reveal isn't reported as a failure.
 */
function isBenignExplorerExit(error: ExecFileException): boolean {
  return process.platform === 'win32' && error.code === EXPLORER_BENIGN_EXIT_CODE;
}

/**
 * Default OS opener. Per platform:
 *   reveal → open the containing folder with the file selected/highlighted;
 *   open   → open the file itself with its default application.
 */
export const defaultOsOpener: OsOpener = async (absPath, action) => {
  if (process.platform === 'darwin') {
    await run('open', action === 'reveal' ? ['-R', absPath] : [absPath]);
    return;
  }
  if (process.platform === 'win32') {
    if (action === 'reveal') {
      await run('explorer.exe', ['/select,', absPath]);
    } else {
      // `start` is a cmd builtin; the empty "" is its window-title argument so a
      // quoted path is not mistaken for the title.
      await run('cmd.exe', ['/c', 'start', '', absPath]);
    }
    return;
  }
  // Linux / other: xdg-open can't select a file, so reveal opens the directory.
  await run('xdg-open', [action === 'reveal' ? dirname(absPath) : absPath]);
};
