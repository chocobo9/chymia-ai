// packages/api/src/config/global-config.ts
// GLOBAL (cross-project) config root — ~/.choco by default.
//
// Home-dir based on purpose: account metadata + provider SECRETS must live
// OUTSIDE any repo (a project's repo-local `data/` dir can be committed/shared;
// API keys must not be). Shared across every project the user opens (Clowder's
// global ~/.cat-cafe model). Overridable via CHOCO_GLOBAL_CONFIG_ROOT so tests
// point it at a temp dir and never touch the real ~/.choco.

import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

/** Env override for the global config root (tests / non-default deployments). */
export const GLOBAL_CONFIG_ROOT_ENV = 'CHOCO_GLOBAL_CONFIG_ROOT';

/** Default global dir name under the user's home (~/.choco). */
const DEFAULT_GLOBAL_DIR = '.choco';

/** Resolve the global config root: CHOCO_GLOBAL_CONFIG_ROOT → ~/.choco. */
export function resolveGlobalConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GLOBAL_CONFIG_ROOT_ENV];
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(homedir(), DEFAULT_GLOBAL_DIR);
}

/** Absolute path of a file under the global config root. */
export function globalConfigPath(
  filename: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveGlobalConfigRoot(env), filename);
}
