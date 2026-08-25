// QA gating suite (dev≠QA, §0.5.3): §A CLI-availability probe — isCliAvailable +
// probeAgentAvailability + the buildApp `agentAvailability` flow into the registry.
//
// Independently authored. The probe is a `which`-style PATH resolution (NOT a
// spawn) with INJECTABLE seams (env / platform / exists), so these tests are
// deterministic and never depend on the host's real PATH. They gate:
//   - a present command resolves true, an absent one false (POSIX PATH scan)
//   - PATHEXT-aware resolution on win32 (claude.cmd / codex.exe match a bare name)
//   - an empty command name is false
//   - a path-bearing command bypasses PATH and is checked directly
//   - probeAgentAvailability: cliCommand()→present=true / absent=false; an
//     unprobeable service (no cliCommand) → fail-open true
//   - buildApp's `agentAvailability` override flows to registry.isAvailable;
//     OMITTED ⇒ all available (the suite default).

import { describe, it, expect, afterEach } from 'vitest';
import { delimiter, join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentMessage } from '@choco/shared';
import {
  isCliAvailable,
  probeAgentAvailability,
  resolveCliCommand,
  type CliAvailabilityOptions,
} from '@choco/api/runtime/cli-availability';
import type { AgentService } from '@choco/api/providers/base';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, CODEX, GEMINI } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

// IMPORTANT (faithful to the product): isCliAvailable splits PATH with node:path's
// `delimiter` and joins entries with node:path's `join` — BOTH host-derived (the
// `platform` option only affects win32 PATHEXT candidate generation, not how PATH
// is split/joined). So we build PATH strings with the host `delimiter` and the
// present-on-disk paths with the host `join`, exercising the real split/scan/join
// logic deterministically wherever the suite runs.

// Two bin dirs joined with the HOST path delimiter.
const BIN_LOCAL = join('opt', 'local', 'bin');
const BIN_USR = join('opt', 'usr', 'bin');
const POSIX_ENV = { PATH: [BIN_LOCAL, BIN_USR].join(delimiter) };

// A win32-style PATH + the standard PATHEXT. The PATH dirs are joined with the host
// delimiter so the product's `delimiter`-split sees two entries on any host.
const WIN_BIN_SYS = join('C:', 'Windows', 'System32');
const WIN_BIN_TOOLS = join('C:', 'tools', 'bin');
const WIN_ENV = {
  PATH: [WIN_BIN_SYS, WIN_BIN_TOOLS].join(delimiter),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

/**
 * Build an `exists` seam that returns true only for the listed paths. The product
 * forms candidate names by appending PATHEXT entries (which are UPPERCASE in our
 * WIN_ENV) to the bare command, then `join`s them onto each PATH dir. We compare
 * case-insensitively (Windows filenames + extensions are case-insensitive) so a
 * present `claude.cmd` matches the product's generated `claude.CMD` candidate —
 * the assertion exercises the real extension-matching logic, not casing.
 */
function existsFor(present: readonly string[]): (path: string) => boolean {
  const norm = (p: string): string => p.toLowerCase();
  const set = new Set(present.map(norm));
  return (path: string): boolean => set.has(norm(path));
}

describe('§A isCliAvailable (POSIX PATH scan)', () => {
  it('happy: a command present on a PATH dir resolves true', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([join(BIN_USR, 'claude')]),
    };
    expect(isCliAvailable('claude', opts)).toBe(true);
  });

  it('edge: a command absent from every PATH dir resolves false', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([join(BIN_USR, 'claude')]), // only claude exists
    };
    expect(isCliAvailable('codex', opts)).toBe(false);
    expect(isCliAvailable('gemini', opts)).toBe(false);
  });

  it('edge: it scans EVERY PATH entry (a command in the second dir still resolves)', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([join(BIN_LOCAL, 'gemini')]), // first-listed dir
    };
    expect(isCliAvailable('gemini', opts)).toBe(true);
  });

  it('adversarial: an empty command name is always false (no PATH probe attempted)', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: () => true, // even if everything "exists", an empty name is false
    };
    expect(isCliAvailable('', opts)).toBe(false);
  });

  it('adversarial: an empty PATH means nothing resolves', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: { PATH: '' },
      exists: () => true,
    };
    expect(isCliAvailable('claude', opts)).toBe(false);
  });

  it('edge: a path-bearing command (absolute) bypasses PATH and is checked directly', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: { PATH: '' }, // empty PATH — irrelevant for an absolute command
      exists: existsFor(['/opt/cli/claude']),
    };
    expect(isCliAvailable('/opt/cli/claude', opts)).toBe(true);
    expect(isCliAvailable('/opt/cli/missing', opts)).toBe(false);
  });
});

describe('§A isCliAvailable (win32 PATHEXT)', () => {
  it('edge: a bare name resolves via its PATHEXT extension (claude.cmd)', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: WIN_ENV,
      // The installed file is claude.cmd in the tools dir; the bare `claude` must
      // match via the .CMD PATHEXT candidate (case-insensitive on Windows).
      exists: existsFor([join(WIN_BIN_TOOLS, 'claude.cmd')]),
    };
    expect(isCliAvailable('claude', opts)).toBe(true);
  });

  it('edge: a .EXE extension also resolves a bare name (codex.exe)', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: WIN_ENV,
      exists: existsFor([join(WIN_BIN_TOOLS, 'codex.exe')]),
    };
    expect(isCliAvailable('codex', opts)).toBe(true);
  });

  it('adversarial: on win32 a bare name with NO matching ext present resolves false', () => {
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: WIN_ENV,
      // gemini.txt is NOT an executable extension in PATHEXT → no candidate matches.
      exists: existsFor([join(WIN_BIN_TOOLS, 'gemini.txt')]),
    };
    expect(isCliAvailable('gemini', opts)).toBe(false);
  });

  it('edge: a custom PATHEXT is honored (only listed extensions are tried)', () => {
    const customBin = join('C:', 'bin');
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: { PATH: customBin, PATHEXT: '.PS1' }, // only .PS1 is executable here
      exists: existsFor([join(customBin, 'tool.ps1')]),
    };
    expect(isCliAvailable('tool', opts)).toBe(true);
    // A .EXE present but .EXE NOT in this PATHEXT → not resolved.
    const opts2: CliAvailabilityOptions = {
      platform: 'win32',
      env: { PATH: customBin, PATHEXT: '.PS1' },
      exists: existsFor([join(customBin, 'tool.exe')]),
    };
    expect(isCliAvailable('tool', opts2)).toBe(false);
  });

  it('regression: agy resolves from LOCALAPPDATA standard install path even when PATH is stale', () => {
    const localAppData = join('C:', 'Users', 'me', 'AppData', 'Local');
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: { PATH: '', PATHEXT: '.EXE', LOCALAPPDATA: localAppData },
      exists: existsFor([join(localAppData, 'agy', 'bin', 'agy.exe')]),
    };
    expect(isCliAvailable('agy', opts)).toBe(true);
  });

  it('regression: agy fallback exposes the absolute executable path for spawn', () => {
    const localAppData = join('C:', 'Users', 'me', 'AppData', 'Local');
    const exe = join(localAppData, 'agy', 'bin', 'agy.exe');
    const opts: CliAvailabilityOptions = {
      platform: 'win32',
      env: { PATH: '', PATHEXT: '.EXE', LOCALAPPDATA: localAppData },
      exists: existsFor([exe]),
    };
    expect(resolveCliCommand('agy', opts)).toBe(exe);
  });
});

describe('§A isCliAvailable (real host probe — node is present)', () => {
  it('happy: the running interpreter `node` resolves true on the real PATH', () => {
    // `node` is guaranteed present (this test runs under node). Real seams.
    expect(isCliAvailable('node')).toBe(true);
  });

  it('adversarial: a definitely-absent command resolves false on the real PATH', () => {
    expect(isCliAvailable('definitely-not-a-real-cli-xyz-9f3b')).toBe(false);
  });
});

/** A service exposing a cliCommand(); injected to drive probeAgentAvailability. */
function serviceWithCli(command: string | undefined): AgentService {
  return {
    invoke(): AsyncIterable<never> {
      return (async function* (): AsyncIterable<never> {})();
    },
    cliCommand: () => command,
  };
}

/** A service WITHOUT cliCommand (unprobeable — the injected-fake shape). */
const unprobeableService: AgentService = {
  invoke(): AsyncIterable<never> {
    return (async function* (): AsyncIterable<never> {})();
  },
};

describe('§A probeAgentAvailability', () => {
  it('happy: maps each agent to its CLI presence (claude present, codex/gemini absent)', () => {
    const services: Record<string, AgentService> = {
      'claude-opus': serviceWithCli('claude'),
      'codex-gpt': serviceWithCli('codex'),
      'gemini-pro': serviceWithCli('gemini'),
    };
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([join(BIN_USR, 'claude')]), // only claude installed
    };
    expect(probeAgentAvailability(services, opts)).toEqual({
      'claude-opus': true,
      'codex-gpt': false,
      'gemini-pro': false,
    });
  });

  it('edge (fail-open): a service with no cliCommand is treated AVAILABLE (true)', () => {
    const services: Record<string, AgentService> = {
      'claude-opus': unprobeableService,
      'codex-gpt': serviceWithCli('codex'),
    };
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([]), // nothing on disk
    };
    const map = probeAgentAvailability(services, opts);
    // Unprobeable claude → fail-open true; probeable-but-absent codex → false.
    expect(map['claude-opus']).toBe(true);
    expect(map['codex-gpt']).toBe(false);
  });

  it('edge (fail-open): a cliCommand() returning undefined is also treated AVAILABLE (true)', () => {
    const services: Record<string, AgentService> = {
      'claude-opus': serviceWithCli(undefined),
    };
    const opts: CliAvailabilityOptions = {
      platform: 'linux',
      env: POSIX_ENV,
      exists: existsFor([]),
    };
    expect(probeAgentAvailability(services, opts)).toEqual({ 'claude-opus': true });
  });

  it('adversarial: an empty services map yields an empty availability map (no crash)', () => {
    expect(probeAgentAvailability({})).toEqual({});
  });
});

// ===========================================================================
// §A — buildApp agentAvailability flow into the registry
// ===========================================================================
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A trivial reply script for a Fake provider. */
function reply(agentId: AgentMessage['agentId'], text: string): AgentMessage[] {
  const ts = Date.now();
  return [
    { type: 'text', agentId, content: text, timestamp: ts },
    { type: 'done', agentId, isFinal: true, timestamp: ts + 1 },
  ];
}

function appWith(
  agentAvailability?: Readonly<Record<string, boolean>>,
): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {
    'claude-opus': new FakeAgentService([reply(CLAUDE, '我来。')]),
    'codex-gpt': new FakeAgentService([reply(CODEX, '我来实现。')]),
    'gemini-pro': new FakeAgentService([reply(GEMINI, '我来评审。')]),
  };
  const app = buildApp({
    db,
    agentServices: fakes,
    ...(agentAvailability !== undefined ? { agentAvailability } : {}),
  });
  cleanups.push(app.close);
  return app;
}

describe('§A buildApp agentAvailability → registry.isAvailable', () => {
  it('edge: an injected agentAvailability map flows through to registry.isAvailable', () => {
    const app = appWith({ 'claude-opus': true, 'codex-gpt': false, 'gemini-pro': false });
    expect(app.registry.isAvailable(CLAUDE)).toBe(true);
    expect(app.registry.isAvailable(CODEX)).toBe(false);
    expect(app.registry.isAvailable(GEMINI)).toBe(false);
  });

  it('regression: OMITTING agentAvailability ⇒ ALL agents available (the suite default)', () => {
    const app = appWith();
    expect(app.registry.isAvailable(CLAUDE)).toBe(true);
    expect(app.registry.isAvailable(CODEX)).toBe(true);
    expect(app.registry.isAvailable(GEMINI)).toBe(true);
  });

  it('edge: with codex unavailable, the router (built by buildApp) routes a no-mention msg to claude', async () => {
    const app = appWith({ 'claude-opus': true, 'codex-gpt': false });
    const targets = await app.router.resolveTargets('开始干活吧', 'thread-flow');
    expect(targets).toEqual([CLAUDE]);
  });
});
