// tests/api/lifecycle-thinking.edge.test.ts — QA gating (dev≠QA, §0.5.3) for the
// persist half of Bug 3b: the message-handler accumulates an agent's `thinking`
// frames and persists the concatenated reasoning under StoredMessage.extra.thinking
// (non-empty only), keeping extra.toolEvents intact and OMITTING extra entirely
// when a turn produced neither thinking nor tools.
//
// Driven through the SAME pipeline the product uses: a FakeAgentService scripts a
// real turn (session_init → thinking → text → tool_use → done) and we POST
// /messages, then assert the persisted reply's extra. This is a real integration
// test — handleThreadMessage's accumulate()/persistReplies() run unmocked over an
// in-memory MessageStore — not a mock of the unit under test.
//
// Edge/adversarial coverage beyond the dev happy path: thinking deltas concatenated
// strictly IN ORDER (interleaved with text/tool frames), a tools-only turn (no
// thinking) → extra has toolEvents but NO thinking key, and a thinking-only turn
// (no tools) → extra has thinking but NO toolEvents key.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage, StoredMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE } from './helpers.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(scripts: Record<string, readonly (readonly AgentMessage[])[]>): BuiltApp {
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db: new Database(':memory:'), agentServices: fakes });
}

const TS = 1_700_000_000_000;
const REASON_1 = '先确认数据模型：Todo { id, title, done, createdAt }。';
const REASON_2 = '再划分端点：集合用 /todos，单项用 /todos/:id。';
const REASON_3 = '最后补 zod 校验，拒绝非法负载。';
const REPLY_TEXT = '已实现 TODO API 的 CRUD 端点，并补充了 zod 校验。';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function postTurn(app: BuiltApp, threadId: string): Promise<StoredMessage[]> {
  cleanups.push(app.close);
  const res = await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: '@claude 写一个带 CRUD 的 TODO API' },
  });
  expect(res.statusCode).toBe(200);
  return res.json<{ replies: StoredMessage[] }>().replies;
}

describe('Bug 3b persist — thinking accumulation (integration, edge/adversarial)', () => {
  it('concatenates thinking deltas STRICTLY IN ORDER even when interleaved with text/tool frames (edge)', async () => {
    // Thinking frames are emitted in three separate deltas, INTERLEAVED with a
    // text frame and a tool_use — the handler must concatenate only the thinking
    // text, in arrival order, regardless of the interleaving.
    const turn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-interleave', timestamp: TS },
      { type: 'thinking', agentId: CLAUDE, content: REASON_1, invocationId: 'inv_i', timestamp: TS + 1 },
      { type: 'text', agentId: CLAUDE, content: '开始：', invocationId: 'inv_i', timestamp: TS + 2 },
      { type: 'thinking', agentId: CLAUDE, content: REASON_2, invocationId: 'inv_i', timestamp: TS + 3 },
      { type: 'tool_use', agentId: CLAUDE, toolName: 'write_file', toolInput: { path: 'src/todo.ts' }, toolUseId: 'tu_1', invocationId: 'inv_i', timestamp: TS + 4 },
      { type: 'thinking', agentId: CLAUDE, content: REASON_3, invocationId: 'inv_i', timestamp: TS + 5 },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_i', timestamp: TS + 6 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_i', timestamp: TS + 7 },
    ];
    const replies = await postTurn(injectApp({ 'claude-opus': [turn] }), 'thread-interleave');

    expect(replies).toHaveLength(1);
    const reply = replies[0];
    // Strict in-order concatenation of ONLY the thinking deltas (text not mixed in).
    expect(reply?.extra?.['thinking']).toBe(`${REASON_1}${REASON_2}${REASON_3}`);
    expect(reply?.content).toBe('开始：' + REPLY_TEXT);
    // toolEvents intact alongside thinking.
    const toolEvents = reply?.extra?.['toolEvents'];
    expect(Array.isArray(toolEvents)).toBe(true);
    expect((toolEvents as unknown[]).length).toBe(1);
  });

  it('a tools-only turn (no thinking) → extra has toolEvents but NO thinking key (edge)', async () => {
    const turn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-toolsonly', timestamp: TS },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_t', timestamp: TS + 1 },
      { type: 'tool_use', agentId: CLAUDE, toolName: 'run_tests', toolInput: { suite: 'todo' }, toolUseId: 'tu_x', invocationId: 'inv_t', timestamp: TS + 2 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_t', timestamp: TS + 3 },
    ];
    const replies = await postTurn(injectApp({ 'claude-opus': [turn] }), 'thread-toolsonly');

    const extra = replies[0]?.extra;
    expect(extra).toBeDefined();
    expect(Array.isArray(extra?.['toolEvents'])).toBe(true);
    // No thinking frames → the thinking key must be ABSENT (not '').
    expect(extra && 'thinking' in extra).toBe(false);
  });

  it('a thinking-only turn (no tools) → extra has thinking but NO toolEvents key (edge)', async () => {
    const turn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-thinkonly', timestamp: TS },
      { type: 'thinking', agentId: CLAUDE, content: REASON_1, invocationId: 'inv_k', timestamp: TS + 1 },
      { type: 'thinking', agentId: CLAUDE, content: REASON_2, invocationId: 'inv_k', timestamp: TS + 2 },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_k', timestamp: TS + 3 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_k', timestamp: TS + 4 },
    ];
    const replies = await postTurn(injectApp({ 'claude-opus': [turn] }), 'thread-thinkonly');

    const extra = replies[0]?.extra;
    expect(extra?.['thinking']).toBe(`${REASON_1}${REASON_2}`);
    expect(extra && 'toolEvents' in extra).toBe(false);
  });

  it('adversarial: a turn that emits ONLY a single empty-content thinking frame omits extra entirely', async () => {
    // An empty thinking delta accumulates to '' → buildReplyExtra must treat the
    // thinking as absent (non-empty-only) and, with no tools, OMIT extra.
    const turn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-emptythink', timestamp: TS },
      { type: 'thinking', agentId: CLAUDE, content: '', invocationId: 'inv_e', timestamp: TS + 1 },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_e', timestamp: TS + 2 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_e', timestamp: TS + 3 },
    ];
    const replies = await postTurn(injectApp({ 'claude-opus': [turn] }), 'thread-emptythink');

    expect(replies[0]?.content).toBe(REPLY_TEXT);
    expect(replies[0]?.extra).toBeUndefined();
  });

  it('the persisted history row (not just the POST result) also carries extra.thinking in order (edge)', async () => {
    const turn: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-history', timestamp: TS },
      { type: 'thinking', agentId: CLAUDE, content: REASON_1, invocationId: 'inv_h', timestamp: TS + 1 },
      { type: 'thinking', agentId: CLAUDE, content: REASON_2, invocationId: 'inv_h', timestamp: TS + 2 },
      { type: 'text', agentId: CLAUDE, content: REPLY_TEXT, invocationId: 'inv_h', timestamp: TS + 3 },
      { type: 'done', agentId: CLAUDE, isFinal: true, invocationId: 'inv_h', timestamp: TS + 4 },
    ];
    const app = injectApp({ 'claude-opus': [turn] });
    await postTurn(app, 'thread-history-think');

    const history = await app.stores.messageStore.getByThread('thread-history-think');
    const reply = history.find((m) => m.origin === 'stream');
    expect(reply?.content).toBe(REPLY_TEXT);
    expect(reply?.extra?.['thinking']).toBe(`${REASON_1}${REASON_2}`);
  });
});
