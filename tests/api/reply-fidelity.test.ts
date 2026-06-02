// tests/api/reply-fidelity.test.ts
// M2 dev (#5 test-fidelity guard): the persisted reply must NOT double when the
// REAL Claude stream-json parser drives the pipeline.
//
// Background: the live-demo doubling bug (assistant reply text emitted twice — once
// as streaming text_deltas, once again as the consolidated `assistant` content block)
// slipped past the 1165-test suite because EVERY integration test used a fake provider
// that emits already-clean AgentMessages (replyScript = one text event). Those fakes
// never reproduce the real "--include-partial-messages" dual shape.
//
// This guard closes that gap end-to-end: it injects RealClaudeParserAgentService, which
// replays RAW stream-json (incremental text_deltas FOLLOWED BY the consolidated
// assistant block) through the actual parseClaudeLine, then runs it through the SAME
// message-handler pipeline (submitPlatformMessage → accumulate → persist). It asserts the
// persisted StoredMessage carries the reply text exactly ONCE. With the parser bug present
// (no streamedText suppression), acc.text would contain the reply twice and this fails.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE } from './helpers.js';
import { RealClaudeParserAgentService } from '../invocation/fake-agent-service.js';

const FIXED_TS = 1_700_000_000_000;

const WECHAT_CHANNEL = 'gh_fidelity9a8b7c6d';
const WECHAT_OPENID = 'oFidelity1234567890abcdefghi';

/** The model's full reply, streamed incrementally then repeated as one consolidated block. */
const REPLY = '我已实现 TODO API 的 CRUD 端点，并补充了输入校验与分页。';
/** Realistic --include-partial-messages chunks of REPLY (model-sized incremental deltas). */
const DELTAS: readonly string[] = ['我已实现 TODO API 的 ', 'CRUD 端点，', '并补充了输入校验与分页。'];

/** Build the RAW Claude stream-json lines: init → text_deltas → consolidated assistant block → success. */
function dualShapeLines(): string[] {
  const deltaLines = DELTAS.map((text) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    }),
  );
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-claude-fidelity', model: 'claude-opus-4-6' }),
    ...deltaLines,
    // The consolidated `assistant` event repeating the SAME full text — the doubling source.
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: REPLY }] } }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ];
}

/** Build an inject-only app whose claude-opus provider drives the REAL parser over raw lines. */
function injectRealParserApp(): { app: BuiltApp; provider: RealClaudeParserAgentService } {
  const db = new Database(':memory:');
  const provider = new RealClaudeParserAgentService(CLAUDE, dualShapeLines(), () => FIXED_TS);
  const app = buildApp({ db, agentServices: { 'claude-opus': provider }, now: () => FIXED_TS });
  return { app, provider };
}

function incoming(text: string): IncomingPlatformMessage {
  return {
    adapterName: 'wechat',
    channelId: WECHAT_CHANNEL,
    platformUserId: WECHAT_OPENID,
    platformMessageId: 'msg_fidelity_1',
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

describe('reply fidelity: real Claude parser dual-shape does not double the persisted reply', () => {
  it('persists the reply text exactly ONCE through the full pipeline (would catch the demo doubling)', async () => {
    // Arrange — provider replays deltas + consolidated block through the real parser.
    const { app } = injectRealParserApp();
    cleanups.push(app.close);

    // Act — drive the SAME pipeline the product uses (resolve ids → handleThreadMessage → persist).
    const result = await app.submitPlatformMessage(incoming('@claude-opus 写一个带 CRUD 的 TODO API'));

    // Assert — one reply, and its content equals REPLY exactly once (not REPLY+REPLY).
    expect(result.replies).toHaveLength(1);
    const reply = result.replies[0];
    expect(reply?.agentId).toBe(CLAUDE);
    expect(reply?.content).toBe(REPLY);
    // Hard anti-doubling guard: the reply substring appears once, never twice.
    const occurrences = reply?.content.split(REPLY).length ?? 0;
    expect(occurrences).toBe(2); // "a<sep>b".split(sep) → ['',''] length 2 ⇒ exactly one occurrence
    expect(reply?.content).not.toBe(`${REPLY}${REPLY}`);
  });

  it('the persisted history row also carries the single un-doubled reply', async () => {
    // Arrange
    const { app } = injectRealParserApp();
    cleanups.push(app.close);

    // Act
    const result = await app.submitPlatformMessage(incoming('@claude-opus 写一个带 CRUD 的 TODO API'));
    const history: StoredMessage[] = await app.stores.messageStore.getByThread(result.threadId);

    // Assert — the stream-origin reply persisted to the store is the single final text.
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(replyMsg?.content).toBe(REPLY);
  });
});
