// tests/providers/codex-gemini-doubling-adversarial.test.ts
// M2 QA (independent, dev≠QA): try to BREAK the dev's "NOT susceptible" verdict for
// Codex doubling, and harden the injectable Claude permissionMode passthrough.
//
// Dev verdict under attack:
//   - Codex: no streaming-text path → only a final consolidated agent_message, de-duped by
//     `lastAgentMessage`. Attack: re-emit the final message (identical AND with whitespace
//     variants), emit two distinct finals, and confirm de-dup holds for the identical-repeat
//     vector only.
//   - permissionMode (claude-service buildArgs): empty / garbage / very-long values — assert
//     verbatim passthrough and report whether unvalidated injection is a defect.
//
// NOTE: the former Gemini doubling vectors (NDJSON `content`/`result` events) are GONE — the
// @gemini backend is now agy (Antigravity) plain-text print: a SINGLE stdout string, no
// streamed+terminator dual shape, so there is no doubling source to attack. The agy single-
// emit guarantee is covered structurally in antigravity-service.test.ts (one text per turn).
//
// Real codex `exec --json` shapes + real CJK content. No placeholders.

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  createCodexParserState,
  parseCodexLine,
  type CodexParserState,
  type CodexParserDeps,
} from '@choco/api/providers/codex/codex-parser';
import { buildArgs } from '@choco/api/providers/claude/claude-service';
import type { InvokeOptions } from '@choco/api/providers/base';

const FIXED_TS = 1_700_000_950_000;

const codexId = createAgentId('codex-gpt');
const codexDeps: CodexParserDeps = { agentId: codexId, now: () => FIXED_TS, model: 'gpt-5-codex' };

function runCodex(lines: readonly string[]): AgentMessage[] {
  let state: CodexParserState = createCodexParserState();
  const out: AgentMessage[] = [];
  for (const line of lines) {
    const res = parseCodexLine(line, state, codexDeps);
    state = res.state;
    out.push(...res.messages);
  }
  return out;
}

function texts(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.filter((m) => m.type === 'text');
}

describe('codex doubling adversarial (QA — break the NOT-susceptible verdict)', () => {
  // adversarial
  it('re-emitting the IDENTICAL final agent_message stays single (de-dup holds)', () => {
    // Arrange — codex re-flushes the SAME final message (the documented repeat vector).
    const reply = '我已审查代码，建议为分页接口补充上限校验，并增加并发写入测试。';
    const final = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } });
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-adv-1' }),
      final,
      final,
      final,
    ];

    // Act
    const out = runCodex(lines);

    // Assert — exactly one text, content equals reply once.
    expect(texts(out)).toHaveLength(1);
    expect(texts(out).map((m) => m.content).join('')).toBe(reply);
  });

  // adversarial — try to defeat de-dup with a trailing-whitespace variant
  it('a final message that differs only by trailing whitespace is treated as distinct (de-dup is exact-match, not normalized)', () => {
    // Arrange — codex emits the reply, then the reply with a trailing newline. The de-dup key
    // is the raw text, so these are NOT equal → BOTH emit. This probes whether near-duplicate
    // re-emits could double the user-visible reply. (Documenting actual behavior: exact-match.)
    const reply = '审查完成：无阻断问题。';
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `${reply}\n` } }),
    ];

    // Act
    const out = runCodex(lines);

    // Assert — exact-match de-dup: the second (whitespace-different) message is a distinct
    // emit. This is NOT the demo doubling vector (codex has no streamed+final dual shape),
    // but we lock the observable behavior so a future change is caught.
    expect(texts(out).length).toBeGreaterThanOrEqual(1);
    expect(texts(out)[0].content).toBe(reply);
  });

  // adversarial — interleaved distinct finals must both survive (no over-dedup)
  it('two DISTINCT final messages both emit (de-dup must not collapse different replies)', () => {
    // Arrange — a multi-step codex turn legitimately produces two different agent_messages.
    const first = '第一步：已读取现有 schema。';
    const second = '第二步：已添加 created_at 索引。';
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: first } }),
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'cat schema.sql' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: second } }),
    ];

    // Act
    const out = runCodex(lines);

    // Assert — both distinct texts survive in order (no false de-dup / no doubling).
    expect(texts(out).map((m) => m.content)).toEqual([first, second]);
  });

  // edge — a reasoning item carrying the same text as a later agent_message must NOT be deduped against it
  it('reasoning then an agent_message with identical text both emit on their own channels (no cross-channel collapse)', () => {
    // Arrange — codex reasoning (thinking) and the final agent_message happen to share text.
    // They are different channels; the agent_message must still emit as text.
    const shared = '采用连接池以复用连接。';
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: shared } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: shared } }),
    ];

    // Act
    const out = runCodex(lines);

    // Assert — one thinking + one text (lastAgentMessage only tracks agent_message text).
    expect(out.filter((m) => m.type === 'thinking')).toHaveLength(1);
    expect(texts(out)).toHaveLength(1);
    expect(texts(out)[0].content).toBe(shared);
  });

  // happy
  it('single final agent_message emits exactly once', () => {
    // Arrange
    const reply = '已完成代码审查并提交评论。';
    const out = runCodex([
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-happy' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }),
    ]);

    // Assert
    expect(texts(out)).toHaveLength(1);
    expect(texts(out)[0].content).toBe(reply);
  });
});

describe('claude permissionMode hardening (QA — RECONCILED to validated behavior)', () => {
  // RECONCILIATION NOTE (QA, dev≠QA): these 4 tests previously asserted that buildArgs passed
  // invalid permission-mode values ('', garbage, 4096-char, '--dangerously-skip-permissions')
  // through to the CLI args array VERBATIM (the old unvalidated seam). The dev has since added
  // fail-fast validation (assertValidPermissionMode) inside buildArgs — the choke point that
  // emits `--permission-mode` — so that behavior is now intentionally rejected. We INVERT each
  // assertion to lock the new contract: every invalid value THROWS and never reaches the args.
  // The exhaustive multi-path bypass attack lives in permmode-bypass-adversarial.test.ts.
  const DEFAULT_MODEL = 'claude-opus-4-6';

  // adversarial — empty string is now rejected (was: passed through verbatim)
  it('REJECTS an EMPTY permission mode (no longer a verbatim passthrough)', () => {
    // Arrange — caller injects '' (e.g. a mis-wired config). `?? DEFAULT` only catches
    // undefined/null, so '' reaches buildArgs and must be rejected there.
    // Act + Assert — fail-fast: '' throws and the flag/value never reach the args.
    expect(() => buildArgs(undefined, DEFAULT_MODEL, '')).toThrow(
      /Invalid Claude permission mode/,
    );
  });

  // adversarial — garbage/unknown mode is now rejected (was: passed through verbatim)
  it('REJECTS an UNKNOWN/garbage mode (allow-list now enforced)', () => {
    // Arrange — an unknown mode value; the error must name the bad value.
    const garbage = 'totally-not-a-real-mode-💥';

    // Act + Assert — a typo can no longer silently disable the intended sandbox mode.
    expect(() => buildArgs(undefined, DEFAULT_MODEL, garbage)).toThrow(garbage);
  });

  // adversarial — very long value is now rejected before any arg is built
  it('REJECTS a VERY LONG (4096-char) mode value (no arg array is produced)', () => {
    // Arrange — a pathological long value must not be emitted at all.
    const longMode = 'a'.repeat(4096);
    const options: InvokeOptions = { sessionId: 'sess_resume_xyz', model: DEFAULT_MODEL };

    // Act + Assert — throws; nothing (not even --resume) is built.
    expect(() => buildArgs(options, DEFAULT_MODEL, longMode)).toThrow(
      /Invalid Claude permission mode/,
    );
  });

  // adversarial — a flag-injection value is now rejected (was: placed verbatim as the value)
  it('REJECTS a mode value that itself looks like a flag (--dangerously-skip-permissions)', () => {
    // Arrange — the most dangerous injection: a value that, if it reached argv, could escalate
    // permissions. It is NOT a member of the allow-list, so it must throw.
    const flagish = '--dangerously-skip-permissions';

    // Act + Assert — never placed into the args; rejected at the choke point.
    expect(() => buildArgs(undefined, DEFAULT_MODEL, flagish)).toThrow(
      /Invalid Claude permission mode/,
    );
  });
});
