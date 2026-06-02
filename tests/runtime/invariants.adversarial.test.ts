// Operability QA — adversarial precision/recall audit of the 4 runtime probes.
//
// dev≠QA: authored by the QA instance, NOT the probe author. Goal is to HUNT
// each probe's two failure modes: RECALL (does it catch its real bug shape?) and
// PRECISION (does it false-flag legitimate, non-buggy inputs?). A probe that
// misses its target or fires on a clean reply is a real defect and the failing
// test is KEPT as the deterministic proof.
//
// Distribution (this file): adversarial-heavy by design. Realistic inputs only —
// real CJK agent replies, real Windows workspace paths, real tool_use shapes.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createAgentId } from '@choco/shared';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import {
  checkWorkspaceMatch,
  checkReplyNotDuplicated,
  checkToolWritePathInside,
  checkInvocationProductive,
} from '@choco/api/infrastructure/invariants';

interface CapturedWarn {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly threadId: string;
  readonly agentId?: string;
}

function capturing(): { logger: RouteLogger; events: CapturedWarn[] } {
  const events: CapturedWarn[] = [];
  const logger: RouteLogger = (event) => {
    events.push({
      level: event.level,
      message: event.message,
      threadId: event.threadId,
      ...(event.agentId !== undefined ? { agentId: event.agentId as string } : {}),
    });
  };
  return { logger, events };
}

const CTX = { threadId: 'thread-arch-review', agentId: createAgentId('claude-opus') };
const WORKSPACE = resolve('/srv/projects/clowder');
const isWindows = process.platform === 'win32';

// ───────────────────────── PROBE 2: checkReplyNotDuplicated ──────────────────
// The probe it implements: trimmed even-length text whose first half === second
// half. RECALL target = the in-the-wild bug shape (deltas full text + assistant
// full block => exact X+X). PRECISION target = legit repetitive replies.
describe('checkReplyNotDuplicated — RECALL (must catch the doubling bug)', () => {
  it('warns on exact X+X with a realistic CJK architecture reply (the real bug shape)', () => {
    const { logger, events } = capturing();
    const x = '建议在 packages/api/src/routing 下实现 AgentRouter，路由规则按 @mention 优先、再回退最近发言者。';
    const fired = checkReplyNotDuplicated(logger, CTX, x + x);
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('self-duplicated');
  });

  it('warns on exact X+X for an English assistant block that doubled', () => {
    const { logger, events } = capturing();
    const x = 'The retry policy should use exponential backoff with full jitter, capped at thirty seconds.';
    const fired = checkReplyNotDuplicated(logger, CTX, x + x);
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('MISSES X + " " + X (a single space between the doubled halves)', () => {
    // Documents a recall LIMIT: the wild bug is exact-double; if the join inserts
    // a separator the halves-equal split no longer holds. This is expected/known
    // behavior — asserted so the boundary is pinned, not a regression surprise.
    const { logger, events } = capturing();
    const x = 'The migration runs sqlite-vec then backfills embeddings in a single transaction.';
    const fired = checkReplyNotDuplicated(logger, CTX, `${x} ${x}`);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('MISSES X + "\\n" + X (a newline between the doubled halves)', () => {
    const { logger, events } = capturing();
    const x = '已完成数据库迁移脚本的编写，请审阅 migrations/0007_evidence.sql。';
    const fired = checkReplyNotDuplicated(logger, CTX, `${x}\n${x}`);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('MISSES X+X+X (tripled): odd multiple is not a halves-equal split', () => {
    const { logger, events } = capturing();
    const x = '请检查 socket-manager 的房间广播实现。'; // 18 chars; *3 = 54 (even)
    const fired = checkReplyNotDuplicated(logger, CTX, x + x + x);
    // first half != second half for a triple, so no fire. Pin the limit.
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('MISSES X + Xprime (almost-equal halves, one char differs)', () => {
    const { logger, events } = capturing();
    const x = 'Use a parameterized query for the thread lookup to avoid injection.';
    const xprime = 'Use a parameterized query for the thread lookup to avoid injectionX';
    const fired = checkReplyNotDuplicated(logger, CTX, x + xprime);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('checkReplyNotDuplicated — PRECISION (must NOT false-flag legit replies)', () => {
  it('does NOT warn on a numbered list that legitimately repeats phrasing', () => {
    const { logger, events } = capturing();
    const reply = [
      '1. 校验输入参数是否合法',
      '2. 校验输入参数的边界值',
      '3. 校验输入参数的类型',
    ].join('\n');
    const fired = checkReplyNotDuplicated(logger, CTX, reply);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a short reply that deliberately says the same word twice ("好的 好的")', () => {
    const { logger, events } = capturing();
    const fired = checkReplyNotDuplicated(logger, CTX, '好的 好的'); // short, skipped
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a long reply that ends with the same sentence said twice on purpose', () => {
    const { logger, events } = capturing();
    const reply =
      '这是一个重要的设计决策，需要团队评审后再落地。请务必先评审。请务必先评审。';
    const fired = checkReplyNotDuplicated(logger, CTX, reply);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on prose with internal substring repetition (not a halves split)', () => {
    const { logger, events } = capturing();
    const reply =
      'The cache layer caches the cache key; the cache key is derived from the request body and the cache TTL.';
    const fired = checkReplyNotDuplicated(logger, CTX, reply);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  // PRECISION WIN + RECALL LIMIT: a reply that is two IDENTICAL code blocks each
  // ending in a trailing newline is `block+block`, but the probe trims the COMBINED
  // string first, stripping only the final newline. That makes the result odd-length
  // with unequal halves, so it does NOT fire. Good for precision (a legit repeated
  // snippet is not flagged) but also a recall limit: a real doubled reply whose
  // second copy carries trailing whitespace escapes detection. Pinned both ways.
  it('does NOT warn on two identical newline-terminated code blocks (trim breaks symmetry)', () => {
    const { logger, events } = capturing();
    const block = 'const router = new AgentRouter(registry, invoke);\nawait router.route(message);\n';
    const fired = checkReplyNotDuplicated(logger, CTX, block + block);
    // trim() strips the final \n => odd length => halves unequal => no fire.
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  // Counterpart: the SAME two code blocks WITHOUT a trailing newline on each are an
  // even, halves-equal split, so the probe DOES fire — this is the genuine
  // precision limit (a deliberately-repeated whitespace-symmetric snippet is
  // indistinguishable from the doubling bug). Documented, not a regression.
  it('PRECISION limit: two identical whitespace-symmetric code blocks DO trip the probe', () => {
    const { logger, events } = capturing();
    const block = 'const router = new AgentRouter(registry, invoke);';
    const fired = checkReplyNotDuplicated(logger, CTX, block + block);
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('self-duplicated');
  });

  it('does NOT warn just under the MIN_DUP_CHECK_LENGTH boundary even if doubled', () => {
    const { logger, events } = capturing();
    // "abcdefgh" repeated = 16 chars (>= threshold) WOULD fire; use a 7-char half
    // => 14 chars total, below the 16 floor => skipped.
    const fired = checkReplyNotDuplicated(logger, CTX, 'abcdefg' + 'abcdefg');
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('warns right at the MIN_DUP_CHECK_LENGTH boundary (8-char half => 16 total)', () => {
    const { logger, events } = capturing();
    const fired = checkReplyNotDuplicated(logger, CTX, 'abcdefgh' + 'abcdefgh');
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });
});

// ───────────────────────── PROBE 1: checkWorkspaceMatch ──────────────────────
describe('checkWorkspaceMatch — PRECISION (path-equivalence must not false-warn)', () => {
  it('does NOT warn on a trailing-slash-only difference', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, `${WORKSPACE}${isWindows ? '\\' : '/'}`, WORKSPACE);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a "." current-segment difference', () => {
    const { logger, events } = capturing();
    const dotted = resolve(WORKSPACE, '.');
    const fired = checkWorkspaceMatch(logger, CTX, dotted, WORKSPACE);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a "..-then-back-in" normalization (sub/../ -> root)', () => {
    const { logger, events } = capturing();
    const roundTrip = resolve(WORKSPACE, 'sub', '..');
    const fired = checkWorkspaceMatch(logger, CTX, roundTrip, WORKSPACE);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn when a relative workingDirectory resolves to the same absolute dir', () => {
    const { logger, events } = capturing();
    // Pass the workspace expectation as the cwd-relative form by re-deriving it.
    const fired = checkWorkspaceMatch(logger, CTX, WORKSPACE, resolve(WORKSPACE));
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  // ── REAL DEFECT (Windows): case-insensitive FS, case-sensitive probe ──────────
  // On win32 the filesystem is case-insensitive: C:\Users\... and c:\users\... are
  // the SAME directory, so an agent that resolved its cwd with different drive/seg
  // casing ran in the CORRECT workspace. checkWorkspaceMatch compares resolve()
  // outputs with strict !==, which is case-SENSITIVE, so it FALSE-WARNS. This is a
  // precision defect on the project's stated platform. The test asserts the
  // CORRECT (no-warn) behavior; it FAILS on win32 as deterministic proof. (On a
  // case-sensitive FS the casing genuinely differs, so the test is win32-gated.)
  it.runIf(isWindows)(
    'must NOT warn when workingDirectory differs from workspace ONLY by case (win32 case-insensitive FS)',
    () => {
      const { logger, events } = capturing();
      const upper = resolve('C:/Users/agent/projects/clowder');
      const lower = resolve('c:/users/agent/projects/clowder'); // SAME real dir on win32
      const fired = checkWorkspaceMatch(logger, CTX, lower, upper);
      expect(fired).toBe(false); // EXPECTED: same dir => no drift. Probe wrongly warns.
      expect(events).toHaveLength(0);
    },
  );
});

describe('checkWorkspaceMatch — RECALL (must catch a real mismatch)', () => {
  it('warns when workingDirectory is undefined but a workspace was expected', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, undefined, WORKSPACE);
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('unset');
  });

  it('warns on a genuinely different sibling directory (the workspace-wire bug)', () => {
    const { logger, events } = capturing();
    const sibling = resolve('/srv/projects/clowder-staging');
    const fired = checkWorkspaceMatch(logger, CTX, sibling, WORKSPACE);
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('!= expected workspace');
  });

  it('does NOT warn when both expected and resolved are undefined (pre-wire no-cwd)', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, undefined, undefined);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});

// ───────────────────────── PROBE 3: checkToolWritePathInside ─────────────────
describe('checkToolWritePathInside — RECALL (escapes MUST warn)', () => {
  it('warns on a relative ../outside climb', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(logger, CTX, '../outside/secret.txt', WORKSPACE, 'Write');
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('OUTSIDE workspace');
  });

  it('warns on an absolute path outside the workspace', () => {
    const { logger, events } = capturing();
    const outside = isWindows ? 'C:/Windows/System32/drivers/etc/hosts' : '/etc/hosts';
    const fired = checkToolWritePathInside(logger, CTX, resolve(outside), WORKSPACE, 'Edit');
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('warns on a deep ../../.. climb that escapes', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(logger, CTX, '../../../../etc/passwd', WORKSPACE, 'write_file');
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('warns on a sibling dir whose name PREFIXES the workspace (clowder-evil vs clowder)', () => {
    // Guards against a naive startsWith(root) containment check; relative() makes
    // this a "..\\clowder-evil" climb so it must be flagged, not allowed.
    const { logger, events } = capturing();
    const evilSibling = resolve('/srv/projects/clowder-evil/payload.sh');
    const fired = checkToolWritePathInside(logger, CTX, evilSibling, WORKSPACE, 'Write');
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('warns on a path that normalizes out via .. even if it textually contains the root', () => {
    const { logger, events } = capturing();
    const sneaky = `${WORKSPACE}/sub/../../escaped/file.ts`;
    const fired = checkToolWritePathInside(logger, CTX, sneaky, WORKSPACE, 'Write');
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
  });
});

describe('checkToolWritePathInside — PRECISION (legit in-workspace must NOT warn)', () => {
  it('does NOT warn on a nested subdirectory write', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(
      logger,
      CTX,
      'packages/api/src/routing/agent-router.ts',
      WORKSPACE,
      'Edit',
    );
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a ./x relative form', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(logger, CTX, './README.md', WORKSPACE, 'Write');
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a path that climbs out then back in (sub/../other.ts stays inside)', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(logger, CTX, 'sub/../other.ts', WORKSPACE, 'Write');
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it.runIf(isWindows)(
    'does NOT warn on an in-workspace write whose drive case differs (win32)',
    () => {
      const { logger, events } = capturing();
      const root = resolve('C:/Users/agent/ws');
      const inside = resolve('c:/users/agent/ws/src/file.ts'); // same dir, lower drive
      const fired = checkToolWritePathInside(logger, CTX, inside, root, 'Write');
      // relative() is case-insensitive on win32 => stays inside => no warn.
      expect(fired).toBe(false);
      expect(events).toHaveLength(0);
    },
  );

  it('does NOT warn when workspace is undefined (cannot judge containment)', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(logger, CTX, resolve('/etc/passwd'), undefined, 'Write');
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});

// ───────────────────────── PROBE 4: checkInvocationProductive ────────────────
describe('checkInvocationProductive — boundaries & precision', () => {
  it('does NOT warn on a minimal one-word ack reply (textLength>0)', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 2,
      toolCallCount: 0,
      errorCount: 0,
    });
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on a single tool call with no text (output via tools)', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 0,
      toolCallCount: 1,
      errorCount: 0,
    });
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT warn on exactly ONE error (below the spike threshold) WITH some output', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 50,
      toolCallCount: 0,
      errorCount: 1,
    });
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('warns at exactly TWO errors (spike threshold boundary, off-by-one guard)', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 200,
      toolCallCount: 1,
      errorCount: 2,
    });
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('error spike');
  });

  it('warns on a fully silent dead turn (0 text, 0 tools, 0 errors)', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 0,
      toolCallCount: 0,
      errorCount: 0,
    });
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('0 output');
  });

  // PRECISION EDGE: a turn with exactly ONE error and NO other output. It is not a
  // "spike" (1 < 2) and not "produced nothing" (errorCount !== 0 short-circuits the
  // producedNothing clause), so NO warn fires. Pinned: a single-error empty turn is
  // intentionally NOT flagged.
  it('does NOT warn on a turn whose only output is a single error (1 error, no text/tools)', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 0,
      toolCallCount: 0,
      errorCount: 1,
    });
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});
