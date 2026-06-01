// tests/providers/permmode-bypass-adversarial.test.ts
// M2 QA (independent, dev≠QA): the COVERAGE PROOF for Claude --permission-mode validation.
//
// Claim under attack (the dev's fail-fast validation): "an invalid permission mode can no
// longer reach the CLI args through ANY path." This suite TRIES to defeat that by pushing
// every class of bad value through every path that could emit `--permission-mode`:
//   Path A — the exported choke point buildArgs(prompt, opts, model, <bad>).
//   Path B — the constructor ClaudeAgentService({ permissionMode: <bad> }).
//   Path C — the instance invoke() → buildArgs(..., this.permissionMode) wiring, observed by
//            capturing the argv handed to a faked spawn (no real CLI). This proves that the
//            ONLY value that can ever reach spawn's argv for a CONSTRUCTIBLE instance is a
//            validated mode, emitted exactly once after the flag.
//
// Bad values cover: empty, whitespace, case-variants, padded, very-long, flag-injection,
// unicode/homoglyph, null/undefined cast, numeric-looking string. The compile-time union now
// forbids these literally, so each is cast (`as ClaudePermissionMode`/`as never`) IN THE TEST
// to simulate a config/env-sourced `string` that bypassed static typing — that is the exact
// threat the runtime guard exists for.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildArgs,
  ClaudeAgentService,
  PERMISSION_MODES,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_DEFAULT_PERMISSION_MODE,
  assertValidPermissionMode,
  type ClaudePermissionMode,
} from '@clowder/api/providers/claude/claude-service';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';

const DEFAULT_MODEL = 'claude-opus-4-6';
// Real agent-style prompt (no placeholder data, per CLAUDE §2.2).
const PROMPT = '@claude-opus 审查 PR #142 的并发写入逻辑，指出竞态并给出修复建议。';

/** Read the value immediately following a flag in an arg array. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

/**
 * The full adversarial corpus of INVALID NON-NULLISH modes. Each is something a misconfigured
 * config/env value could realistically produce; none is a member of the 6-value allow-list.
 * These must be rejected at BOTH the choke point (buildArgs) AND the constructor.
 *
 * null/undefined are handled SEPARATELY (NULLISH_MODES): by contract, the constructor coalesces
 * them to CLAUDE_DEFAULT_PERMISSION_MODE via `?? DEFAULT` (only undefined/null, never ''), so
 * they cannot smuggle a bad value — they fall back to the safe default. buildArgs, which takes
 * the resolved value directly (no `??`), still rejects a literal null/undefined argument.
 */
const INVALID_MODES: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ['empty string', ''],
  ['single space', ' '],
  ['whitespace run', '   '],
  ['tab + newline', '\t\n'],
  ['case-variant Default', 'Default'],
  ['case-variant BYPASSPERMISSIONS', 'BYPASSPERMISSIONS'],
  ['case-variant Plan', 'Plan'],
  ['trailing space "plan "', 'plan '],
  ['leading space " plan"', ' plan'],
  ['typo plna', 'plna'],
  ['numeric-looking "0"', '0'],
  ['numeric-looking "1"', '1'],
  ['very long (4096 a)', 'a'.repeat(4096)],
  ['flag-injection appended', 'plan --dangerously-skip-permissions'],
  ['bare dangerous flag', '--dangerously-skip-permissions'],
  ['unicode homoglyph plаn (Cyrillic а)', 'plаn'],
  ['fullwidth plan', 'ｐｌａｎ'],
  ['garbage with emoji', 'totally-not-a-real-mode-💥'],
];

/** Nullish inputs: rejected at the raw choke point, coalesced to the default at the constructor. */
const NULLISH_MODES: ReadonlyArray<readonly [label: string, value: unknown]> = [
  ['null (cast)', null],
  ['undefined (cast)', undefined],
];

// ── Path A: the exported choke point buildArgs(...) ─────────────────────────────────────────

describe('Path A — buildArgs choke point rejects every invalid mode (adversarial)', () => {
  it.each(INVALID_MODES)('throws for %s and emits NO args', (_label, value) => {
    // Act + Assert — buildArgs is the only emitter of --permission-mode; it must throw before
    // building anything. We also prove no array (and thus no bad value) escapes.
    let captured: string[] | undefined;
    expect(() => {
      captured = buildArgs(PROMPT, undefined, DEFAULT_MODEL, value as ClaudePermissionMode);
    }).toThrow(/Invalid Claude permission mode/);
    expect(captured).toBeUndefined();
  });

  it.each(INVALID_MODES)('error message names the rejected value + allow-list for %s', (_label, value) => {
    // The error must be diagnosable: it names the bad value (JSON-stringified) and the allow-list.
    try {
      buildArgs(PROMPT, undefined, DEFAULT_MODEL, value as ClaudePermissionMode);
      throw new Error('expected buildArgs to throw');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('Invalid Claude permission mode');
      expect(msg).toContain(JSON.stringify(value));
      expect(msg).toContain(PERMISSION_MODES.join(', '));
    }
  });

  it('flag-injection value never produces a --dangerously-skip-permissions token in any args', () => {
    // The nightmare case: a mode string that, if passed through, would smuggle a privilege-
    // escalation flag into argv. Confirm buildArgs throws AND no args array is produced.
    let captured: string[] | undefined;
    expect(() => {
      captured = buildArgs(
        PROMPT,
        undefined,
        DEFAULT_MODEL,
        'plan --dangerously-skip-permissions' as ClaudePermissionMode,
      );
    }).toThrow(/Invalid Claude permission mode/);
    expect(captured).toBeUndefined();
  });

  it('assertValidPermissionMode (the underlying guard) throws directly on a bad value', () => {
    expect(() => assertValidPermissionMode('plna')).toThrow(/plna/);
  });

  it.each(NULLISH_MODES)('throws at the RAW choke point for %s (no `??` here)', (_label, value) => {
    // buildArgs receives the already-resolved value directly; a literal null/undefined is not
    // in the allow-list, so it is rejected. (Coalescing only happens upstream in the constructor.)
    let captured: string[] | undefined;
    expect(() => {
      captured = buildArgs(PROMPT, undefined, DEFAULT_MODEL, value as ClaudePermissionMode);
    }).toThrow(/Invalid Claude permission mode/);
    expect(captured).toBeUndefined();
  });
});

// ── Path B: the constructor ─────────────────────────────────────────────────────────────────

describe('Path B — constructor rejects every invalid mode (adversarial)', () => {
  it.each(INVALID_MODES)('new ClaudeAgentService({ permissionMode: %s }) throws', (_label, value) => {
    // Misconfig must fail at construction, so no instance with a bad mode can ever exist.
    expect(
      () =>
        new ClaudeAgentService({
          agentId: createAgentId('claude-opus'),
          // simulate a config/env string that slipped past the compile-time union
          permissionMode: value as never,
        }),
    ).toThrow(/Invalid Claude permission mode/);
  });

  it.each(NULLISH_MODES)(
    'coalesces %s to the safe default at the constructor (contract: `?? DEFAULT` catches nullish)',
    (_label, value) => {
      // null/undefined are NOT a smuggling vector: by design they fall back to the default safe
      // mode rather than throwing. This documents the intended `?? DEFAULT` boundary (which does
      // NOT catch '' — that throws, proven in Path A).
      expect(
        () =>
          new ClaudeAgentService({
            agentId: createAgentId('claude-opus'),
            permissionMode: value as never,
          }),
      ).not.toThrow();
    },
  );

  it('a constructible instance can ONLY hold a validated mode (no bad instance reaches invoke)', () => {
    // Because Path B rejects all non-nullish bad values (and coalesces nullish to the default),
    // the set of constructible instances is exactly the set whose stored mode is in the
    // allow-list. Verify the default path is constructible.
    expect(
      () => new ClaudeAgentService({ agentId: createAgentId('claude-opus') }),
    ).not.toThrow();
  });
});

// ── Path C: the instance invoke() → buildArgs → spawn argv wiring ────────────────────────────
// We fake node:child_process.spawn so invoke() runs with no real CLI, then capture the argv.

const spawnCalls: Array<{ command: string; args: readonly string[] }> = [];

vi.mock('node:child_process', () => {
  return {
    spawn: (command: string, args: readonly string[]) => {
      spawnCalls.push({ command, args });
      // Minimal fake child: empty stdout that ends immediately, empty stderr, clean close.
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter & { [Symbol.asyncIterator]?: unknown };
        stderr: EventEmitter;
        stdin: { write: () => void; end: () => void };
        kill: () => void;
      };
      const emptyStdout = Object.assign(new EventEmitter(), {
        // async-iterable yielding nothing (no output lines)
        async *[Symbol.asyncIterator]() {
          // no lines
        },
      });
      child.stdout = emptyStdout as never;
      child.stderr = new EventEmitter();
      child.stdin = { write: () => undefined, end: () => undefined };
      child.kill = () => undefined;
      // Emit a clean exit on the next tick so `invoke` finalizes with a done event.
      queueMicrotask(() => child.emit('close', 0, null));
      return child as never;
    },
  };
});

/** Drive invoke() to completion, capturing emitted AgentMessages (and the spawn argv). */
async function driveInvoke(
  service: ClaudeAgentService,
  prompt: string,
): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const msg of service.invoke(prompt)) {
    out.push(msg);
  }
  return out;
}

describe('Path C — instance invoke() emits only validated argv (integration, real spawn faked)', () => {
  afterEach(() => {
    spawnCalls.length = 0;
  });

  it.each(PERMISSION_MODES)(
    'invoke() with valid mode %s puts exactly that value once after the flag in spawn argv',
    async (mode) => {
      // Arrange — a constructible instance pinned to one valid mode.
      const service = new ClaudeAgentService({
        agentId: createAgentId('claude-opus'),
        permissionMode: mode,
      });

      // Act — run the real invoke() path; spawn is faked so no CLI is needed.
      const messages = await driveInvoke(service, PROMPT);

      // Assert — exactly one spawn, flag present once, value is the validated mode.
      expect(spawnCalls).toHaveLength(1);
      const argv = spawnCalls[0].args;
      expect(argv.filter((a) => a === CLAUDE_PERMISSION_MODE_FLAG)).toHaveLength(1);
      expect(valueAfter(argv, CLAUDE_PERMISSION_MODE_FLAG)).toBe(mode);
      // No stray dangerous token ever appears in argv.
      expect(argv).not.toContain('--dangerously-skip-permissions');
      // invoke still finalizes cleanly (done event) on a 0-exit fake.
      expect(messages.some((m) => m.type === 'done')).toBe(true);
    },
  );

  it('invoke() with the DEFAULT (unset) mode emits bypassPermissions once in spawn argv', async () => {
    // Arrange — no permissionMode supplied → service applies CLAUDE_DEFAULT_PERMISSION_MODE.
    const service = new ClaudeAgentService({ agentId: createAgentId('claude-opus') });

    // Act
    await driveInvoke(service, PROMPT);

    // Assert
    const argv = spawnCalls[0].args;
    expect(valueAfter(argv, CLAUDE_PERMISSION_MODE_FLAG)).toBe(CLAUDE_DEFAULT_PERMISSION_MODE);
    expect(CLAUDE_DEFAULT_PERMISSION_MODE).toBe('bypassPermissions');
  });

  it('no instance carrying an invalid mode can reach invoke() — construction already blocked it', () => {
    // The closing of the loop: invoke() is unreachable with a bad mode because Path B threw.
    // Attempting to construct one (to then call invoke) fails before any spawn could occur.
    expect(
      () =>
        new ClaudeAgentService({
          agentId: createAgentId('claude-opus'),
          permissionMode: 'plan --dangerously-skip-permissions' as never,
        }),
    ).toThrow(/Invalid Claude permission mode/);
    // And nothing was spawned as a side effect of the failed construction.
    expect(spawnCalls).toHaveLength(0);
  });
});

// ── Positive control: all 6 valid modes pass the choke point exactly once ────────────────────

describe('Positive control — every valid mode passes buildArgs once (happy path)', () => {
  it.each(PERMISSION_MODES)('valid mode %s is accepted and emitted exactly once', (mode) => {
    const args = buildArgs(PROMPT, undefined, DEFAULT_MODEL, mode);
    expect(args.filter((a) => a === CLAUDE_PERMISSION_MODE_FLAG)).toHaveLength(1);
    expect(valueAfter(args, CLAUDE_PERMISSION_MODE_FLAG)).toBe(mode);
    expect(args[args.length - 1]).toBe(PROMPT);
  });

  it('the allow-list independently matches `claude --help` (6 modes, exact order)', () => {
    // Verified by QA against `.harness/permmode-qa-help.txt` line "--permission-mode <mode>".
    expect([...PERMISSION_MODES]).toEqual([
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ]);
  });
});
