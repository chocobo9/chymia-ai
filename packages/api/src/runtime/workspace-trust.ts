// workspace-trust — VSCode-style "do you trust this workspace?" persistence.
//
// Agents run CLIs that operate on the workspace's files; some refuse to act
// autonomously in an UNTRUSTED directory (gemini won't headless auto-approve
// unless its cwd is trusted — the dogfood "not running in a trusted directory"
// failure). Trust is granted ONCE per workspace path and remembered (like
// VSCode's folder trust), so startup proceeds without re-prompting. The grant is
// the ONLY thing that lets us honestly set the providers' trust env flags — we
// never auto-approve in a directory the user hasn't explicitly trusted.
//
// This module is the reusable CORE (store + env application). The interactive
// prompt is the caller's job (a terminal readline in `scripts/ensure-trust.ts`
// today; a GUI dialog in the future packaged app) — both persist through here.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Env var the gemini CLI reads to allow headless auto-approve in its cwd (its own docs). */
export const GEMINI_TRUST_ENV_KEY = 'GEMINI_CLI_TRUST_WORKSPACE';

/** Env override for the trust-store file path. */
export const TRUST_STORE_ENV = 'CHOCO_TRUST_STORE';
/** Env flag that grants trust non-interactively (headless / CI / background launch). */
export const TRUST_FLAG_ENV = 'CHOCO_TRUST_WORKSPACE';
/** Default trust-store path, under the gitignored runtime `data/` dir. */
const DEFAULT_TRUST_STORE = 'data/trusted-workspaces.json';

/** Resolve the trust-store path: CHOCO_TRUST_STORE → default, made absolute vs `cwd`. */
export function resolveTrustStorePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env[TRUST_STORE_ENV];
  const raw = configured !== undefined && configured.length > 0 ? configured : DEFAULT_TRUST_STORE;
  return resolve(cwd, raw);
}

/** Whether an env flag value grants trust non-interactively (`1` / `true`). */
export function isTrustFlagSet(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Persisted file shape: a list of trusted absolute workspace paths. */
interface TrustFile {
  readonly trusted: readonly string[];
}

/**
 * Normalize a path for stable comparison: absolute, and case-folded on win32
 * (Windows paths are case-insensitive, so `D:\X` and `d:\x` are the same dir).
 */
function normalize(path: string): string {
  const abs = resolve(path);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * File-backed set of trusted workspace paths. Fail-open on a missing/corrupt
 * file (→ nothing trusted, never throws). Mirrors the JsonAgentOverrideStore
 * persistence shape (one small JSON file under the runtime `data/` dir).
 */
export class WorkspaceTrustStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private read(): Set<string> {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<TrustFile>;
      const list = Array.isArray(parsed.trusted) ? parsed.trusted : [];
      return new Set(list.filter((p): p is string => typeof p === 'string').map(normalize));
    } catch {
      return new Set();
    }
  }

  /** Whether `workspace` has been trusted before. */
  isTrusted(workspace: string): boolean {
    return this.read().has(normalize(workspace));
  }

  /** Persist trust for `workspace` (idempotent); creates the file/dir as needed. */
  trust(workspace: string): void {
    const set = this.read();
    set.add(normalize(workspace));
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body: TrustFile = { trusted: [...set] };
    writeFileSync(this.filePath, JSON.stringify(body, null, 2), 'utf-8');
  }
}

/**
 * Apply the trust env flags for a trusted workspace onto `env` (mutates it):
 * sets GEMINI_CLI_TRUST_WORKSPACE=true so gemini's headless auto-approve works.
 * Single point to add other providers' trust flags as they appear. Call ONLY
 * after the workspace is confirmed trusted.
 */
export function applyWorkspaceTrustEnv(env: NodeJS.ProcessEnv): void {
  env[GEMINI_TRUST_ENV_KEY] = 'true';
}
