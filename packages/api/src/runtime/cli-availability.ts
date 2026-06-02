// packages/api/src/runtime/cli-availability.ts
// §A Availability detection — resolve each rostered agent's availability by
// whether its provider CLI is actually installed/resolvable on THIS system.
//
// Clowder grounds availability in CLI resolution (utils/cli-resolve.ts +
// isCatAvailable): a cat is routable iff its CLI resolves. We mirror that intent
// — claude resolves on this machine, codex/gemini do not — but DERIVE it at boot
// (the EDGE / composition root) rather than hardcoding `available:false` in
// agents.yaml (which would be wrong on a machine that HAS codex/gemini).
//
// The probe is a `which`/PATH resolution for a command name, NOT a spawn: it
// only asks "is this executable on PATH?" so it is fast and side-effect-free
// (no agent is invoked). Cross-platform: PATHEXT-aware on win32 (claude.cmd /
// codex.exe), plain PATH scan on POSIX. An absolute/relative path command is
// checked for existence directly. This lives in the runtime (edge) layer — never
// inside buildApp — so tests with injected fakes never touch the filesystem.

import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentService } from '@choco/api/providers/base';

/** Environment slice the probe reads (injectable for deterministic tests). */
export interface CliProbeEnv {
  /** Search PATH (delimiter-separated). */
  readonly PATH?: string;
  /** Windows executable extensions (e.g. `.COM;.EXE;.BAT;.CMD`). win32 only. */
  readonly PATHEXT?: string;
}

/** Options for {@link isCliAvailable} — injectable seams for tests. */
export interface CliAvailabilityOptions {
  /** Env override (defaults to process.env). */
  readonly env?: CliProbeEnv;
  /** Platform override (defaults to process.platform). */
  readonly platform?: NodeJS.Platform;
  /**
   * Existence check (defaults to a real `fs.accessSync(..., X_OK)`). Returns true
   * iff the path names an existing (executable) file. Injectable so tests do not
   * depend on the host's real PATH contents.
   */
  readonly exists?: (path: string) => boolean;
}

/** Default existence check: the path is an accessible (executable) file. */
function defaultExists(path: string): boolean {
  try {
    // X_OK is ignored on win32 (everything reports executable); on POSIX it
    // correctly requires the +x bit. F_OK alone would also work — we use X_OK
    // so a non-executable same-named file on POSIX isn't treated as a CLI.
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Candidate filenames for a command on win32: the bare name PLUS the name with
 * each PATHEXT extension (so `claude` matches `claude.cmd` / `claude.exe`). On
 * POSIX the only candidate is the bare name.
 */
function commandCandidates(command: string, platform: NodeJS.Platform, pathext: string): string[] {
  if (platform !== 'win32') return [command];
  const exts = pathext
    .split(delimiter)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  // Bare name first (an already-extensioned command resolves directly), then each ext.
  return [command, ...exts.map((ext) => `${command}${ext}`)];
}

/**
 * Resolve whether a CLI `command` is installed/runnable on this system — a
 * `which`-style PATH resolution (NOT a spawn). An absolute or path-bearing
 * command is checked for existence directly; a bare command name is searched on
 * each PATH entry (PATHEXT-aware on win32).
 *
 * Returns false for an empty command. Pure w.r.t. the injected seams.
 */
export function isCliAvailable(command: string, options: CliAvailabilityOptions = {}): boolean {
  if (command.length === 0) return false;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? defaultExists;
  const pathext = env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';

  const candidateNames = commandCandidates(command, platform, pathext);

  // A path-bearing command (absolute, or containing a separator) bypasses PATH.
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return candidateNames.some((name) => exists(name));
  }

  const pathDirs = (env.PATH ?? '').split(delimiter).filter((d) => d.length > 0);
  for (const dir of pathDirs) {
    for (const name of candidateNames) {
      if (exists(join(dir, name))) return true;
    }
  }
  return false;
}

/**
 * Probe the availability of every rostered agent by resolving its provider's
 * CLI command on this system. A service that does not expose {@link
 * AgentService.cliCommand} (or returns undefined) cannot be probed ⇒ treated as
 * available (fail-open, matching injected fakes / a provider we can't introspect).
 *
 * @returns a `{ [agentId]: boolean }` availability map ready to hand to buildApp.
 */
export function probeAgentAvailability(
  services: Readonly<Record<string, AgentService>>,
  options: CliAvailabilityOptions = {},
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [agentId, service] of Object.entries(services)) {
    const command = service.cliCommand?.();
    // Unprobeable (no cliCommand / undefined) → fail-open available.
    out[agentId] = command === undefined ? true : isCliAvailable(command, options);
  }
  return out;
}
