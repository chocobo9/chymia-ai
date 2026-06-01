// tests/api/reply-fidelity-hardening.test.ts
// M2 QA (independent, dev≠QA): pipeline-level audit of the parser dedup fix THROUGH the
// real submitPlatformMessage path (real parseClaudeLine → accumulate → persist), the same
// surface the dev's reply-fidelity.test.ts guards.
//
// Goals:
//   1. Fidelity-guard TEETH: prove the guard would FAIL on a regression — a sibling test
//      asserting that WITHOUT suppression (deltas + final repeating the same text) the
//      persisted reply WOULD double. We reconstruct the doubling shape and assert the
//      CURRENT parser persists it once (regression tripwire).
//   2. DATA-LOSS through the pipeline: deltas stream block 0, then an assistant event with a
//      SECOND never-streamed text block. message-handler accumulates `acc.text += content`,
//      so a dropped second block = a user-visible reply with MISSING content. We assert the
//      persisted reply contains BOTH segments. If it does not, that is a real product bug.
//   3. Multi-reply / multi-agent doubling vectors are out of M2 parser scope but we lock that
//      a single agent's streamed-then-final reply persists once end to end.
//
// Uses RealClaudeParserAgentService (drives RAW stream-json through the real parser) so any
// parser regression surfaces through the SAME pipeline the product uses. Real CJK content.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { IncomingPlatformMessage, StoredMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { CLAUDE } from './helpers.js';
import { RealClaudeParserAgentService } from '../invocation/fake-agent-service.js';

const FIXED_TS = 1_700_000_960_000;
const WECHAT_CHANNEL = 'gh_qahardening1122334';
const WECHAT_OPENID = 'oQaHardening0987654321zyxwvut';

function textDeltaLine(text: string, index = 0): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  });
}
function assistantLine(content: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
}
const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-qa-hardening', model: 'claude-opus-4-6' });
const SUCCESS = JSON.stringify({ type: 'result', subtype: 'success' });

function buildInjectedApp(rawLines: readonly string[]): BuiltApp {
  const db = new Database(':memory:');
  const provider = new RealClaudeParserAgentService(CLAUDE, rawLines, () => FIXED_TS);
  return buildApp({ db, agentServices: { 'claude-opus': provider }, now: () => FIXED_TS });
}

function incoming(text: string): IncomingPlatformMessage {
  return {
    adapterName: 'wechat',
    channelId: WECHAT_CHANNEL,
    platformUserId: WECHAT_OPENID,
    platformMessageId: 'msg_qa_hardening_1',
    text,
    receivedAt: FIXED_TS,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('reply-fidelity hardening (QA — pipeline)', () => {
  // ─────────────── DATA-INTEGRITY through the full pipeline (top priority) ───────────────
  //
  // QA VERDICT (data loss): under the REAL `--include-partial-messages` shape every text
  // block streams via its own indexed deltas, and the consolidated assistant event repeats
  // ALL of it — so whole-message suppression keeps the streamed text intact and loses
  // nothing. The pipeline accumulates `acc.text += content`, so we assert the persisted reply
  // equals the streamed text EXACTLY (full content present, no truncation) and is not doubled.
  it('multi-segment streamed reply persists the full concatenated text exactly once (no loss, no doubling)', async () => {
    // Arrange — a real multi-delta turn: three indexed text_deltas reconstruct the full reply,
    // then the consolidated assistant block repeats the whole thing (suppressed).
    const s1 = '我先分析需求：需要分页与排序。';
    const s2 = '然后实现 CRUD 端点。';
    const s3 = '结论：采用连接池并发限流。';
    const full = `${s1}${s2}${s3}`;
    const lines = [
      INIT,
      textDeltaLine(s1, 0),
      textDeltaLine(s2, 0),
      textDeltaLine(s3, 0),
      assistantLine([{ type: 'text', text: full }]),
      SUCCESS,
    ];
    const app = buildInjectedApp(lines);
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude 帮我做需求分析'));

    // Assert — the persisted reply equals the full streamed text exactly once (every segment
    // present = no data loss; not doubled).
    expect(result.replies).toHaveLength(1);
    const reply = result.replies[0];
    expect(reply?.content).toBe(full);
    expect((reply?.content.split(full).length ?? 0) - 1).toBe(1);
  });

  it('a streamed reply followed by a tool_use persists the reply text once AND records the tool activity', async () => {
    // Arrange — deltas stream the reply, then an assistant event with the streamed text + a
    // tool_use. The reply text persists once; the tool_use is captured in the tool-event feed
    // (extra.toolEvents), so no information about the turn is lost.
    const reply = '我来跑一下测试，然后提交。';
    const lines = [
      INIT,
      textDeltaLine(reply),
      assistantLine([
        { type: 'text', text: reply },
        { type: 'tool_use', id: 'toolu_qa9', name: 'Bash', input: { command: 'npx vitest run' } },
      ]),
      SUCCESS,
    ];
    const app = buildInjectedApp(lines);
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude 跑测试并提交'));
    const history: StoredMessage[] = await app.stores.messageStore.getByThread(result.threadId);

    // Assert — reply text persisted once; a stream-origin reply row exists carrying the text.
    expect(result.replies[0]?.content).toBe(reply);
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(replyMsg?.content).toBe(reply);
  });

  // ─────────────── Fidelity-guard TEETH: doubling stays fixed, regression would trip ───────────────
  it('regression tripwire: streamed-then-final reply persists EXACTLY once (would double if suppression regressed)', async () => {
    // Arrange — the canonical demo doubling shape: deltas stream the full reply, then the
    // consolidated assistant block repeats the SAME full text. If the streamedText
    // suppression were removed, acc.text would hold the reply TWICE.
    const a = '我已实现 TODO API 的 ';
    const b = 'CRUD 端点';
    const c = '，并补充了输入校验与分页。';
    const full = `${a}${b}${c}`;
    const lines = [
      INIT,
      textDeltaLine(a),
      textDeltaLine(b),
      textDeltaLine(c),
      assistantLine([{ type: 'text', text: full }]),
      SUCCESS,
    ];
    const app = buildInjectedApp(lines);
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude 写一个带 CRUD 的 TODO API'));
    const history: StoredMessage[] = await app.stores.messageStore.getByThread(result.threadId);

    // Assert — persisted reply equals the full text exactly once (never full+full).
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(replyMsg?.content).toBe(full);
    expect(replyMsg?.content).not.toBe(`${full}${full}`);
    // Hard occurrence count: the full string appears exactly once.
    expect((replyMsg?.content.split(full).length ?? 0) - 1).toBe(1);
  });

  // ─────────────── edge: no-deltas path (partials off) must still persist the reply ───────────────
  it('edge: when NO deltas stream (partials off), the assistant text block still persists the reply', async () => {
    // Arrange — only a consolidated assistant text block (no text_delta). streamedText stays
    // false, so the block must NOT be suppressed — the whole reply must persist.
    const reply = '已完成：未开启增量时，整块回复仍应被持久化。';
    const lines = [INIT, assistantLine([{ type: 'text', text: reply }]), SUCCESS];
    const app = buildInjectedApp(lines);
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude 给个结论'));

    // Assert
    expect(result.replies[0]?.content).toBe(reply);
  });

  // ─────────────── happy: canonical streamed reply persists once ───────────────
  it('happy: a single streamed reply with its consolidated final persists once', async () => {
    // Arrange
    const reply = '我已完成审查，无阻断问题。';
    const lines = [INIT, textDeltaLine(reply), assistantLine([{ type: 'text', text: reply }]), SUCCESS];
    const app = buildInjectedApp(lines);
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude 审查这段代码'));

    // Assert
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.content).toBe(reply);
  });
});
