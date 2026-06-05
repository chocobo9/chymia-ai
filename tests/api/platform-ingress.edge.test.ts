// G3 QA — submitPlatformMessage edge + adversarial coverage (dev≠QA).
//
// Independently authored against the FROZEN ingress contract: an inbound
// IncomingPlatformMessage resolves A10 ids (find-or-create), drives the SAME
// pipeline as POST /api/threads/:id/messages (the message-routes→message-handler
// extraction), and returns the persisted replies. Attacks:
//   - returned replies EQUAL what was persisted (getByThread parity)
//   - repeat-from-same-channel reuses the thread; only one thread row ever
//   - cross-adapter same channelId → two independent threads + transcripts
//   - an @mention in the platform text routes through the SAME router path (parity)
//   - empty-agent / no-mention / provider-throws does not orphan or corrupt mappings
//   - BEHAVIOR-PARITY: HTTP POST vs submitPlatformMessage persist equivalently
//     (the refactor must not have drifted frozen M8 semantics)
// Real platform-shaped ids + real @mention + real CJK content (CLAUDE §2.2).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type {
  AgentId,
  AgentMessage,
  StoredMessage,
  IncomingPlatformMessage,
} from '@choco/shared';
import type { AgentService, InvokeOptions } from '@choco/api/providers/base';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, CODEX, replyScript } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const WECHAT_CHANNEL = 'gh_a1b2c3d4e5f6';
const WECHAT_OPENID = 'oABCdEf1234567890ghijklmnop';
const TELEGRAM_USER_ID = '529384716';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function injectApp(scripts: Record<string, readonly (readonly AgentMessage[])[]>): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  const app = buildApp({ db, agentServices: fakes });
  cleanups.push(app.close);
  return app;
}

/** A WeChat-shaped inbound message carrying `text`. */
function wechatIncoming(text: string, channelId = WECHAT_CHANNEL): IncomingPlatformMessage {
  return {
    adapterName: 'wechat',
    channelId,
    platformUserId: WECHAT_OPENID,
    platformMessageId: `wx_msg_${Math.random().toString(36).slice(2)}`,
    text,
    receivedAt: 1_700_000_000_000,
  };
}

/** A provider that yields text then throws mid-stream (fault injection). */
class ThrowingAgentService implements AgentService {
  constructor(private readonly agentId: AgentId) {}
  invoke(_prompt: string, _options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const agentId = this.agentId;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: 'sess-fault', timestamp: Date.now() };
      yield { type: 'text', agentId, content: '开始分析…', timestamp: Date.now() + 1 };
      throw new Error('上游 CLI 进程意外退出 (exit 137)');
    })();
  }
}

describe('submitPlatformMessage reply/persist parity (edge)', () => {
  it('returned replies EQUAL the persisted agent messages on the resolved thread', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '建议先压测读写比例，再决定 Postgres 还是 SQLite。')],
    });

    const result = await app.submitPlatformMessage(
      wechatIncoming('@claude-opus 帮我评估一下 Postgres 还是 SQLite'),
    );

    const persistedReplies = (await app.stores.messageStore.getByThread(result.threadId)).filter(
      (m) => m.origin === 'stream',
    );
    // The replies the adapter will send back must be exactly what is in storage.
    expect(result.replies.map((r) => r.id)).toEqual(persistedReplies.map((r) => r.id));
    expect(result.replies[0]?.content).toBe(persistedReplies[0]?.content);
    expect(result.replies[0]?.agentId).toBe(CLAUDE);
  });

  it('only ONE thread row exists after repeated messages from the same channel', async () => {
    const app = injectApp({
      'claude-opus': [
        replyScript(CLAUDE, '第一轮。'),
        replyScript(CLAUDE, '第二轮。'),
        replyScript(CLAUDE, '第三轮。'),
      ],
    });

    const r1 = await app.submitPlatformMessage(wechatIncoming('@claude-opus 第一问'));
    const r2 = await app.submitPlatformMessage(wechatIncoming('@claude-opus 第二问'));
    const r3 = await app.submitPlatformMessage(wechatIncoming('@claude-opus 第三问'));

    expect(new Set([r1.threadId, r2.threadId, r3.threadId]).size).toBe(1);
    const threads = (await app.stores.threadStore.list()).filter((t) => t.id === r1.threadId);
    expect(threads).toHaveLength(1);
    // 3 user + 3 replies on the single thread.
    expect(await app.stores.messageStore.getByThread(r1.threadId, 50)).toHaveLength(6);
  });
});

describe('submitPlatformMessage isolation (edge)', () => {
  it('the same channelId under two adapters yields two independent threads + transcripts', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '微信侧回复。'), replyScript(CLAUDE, 'Telegram 侧回复。')],
    });
    const shared = '584213099';

    const wx = await app.submitPlatformMessage({
      adapterName: 'wechat',
      channelId: shared,
      platformUserId: WECHAT_OPENID,
      platformMessageId: 'wx_1',
      text: '@claude-opus 微信问题',
      receivedAt: 1_700_000_000_000,
    });
    const tg = await app.submitPlatformMessage({
      adapterName: 'telegram',
      channelId: shared,
      platformUserId: TELEGRAM_USER_ID,
      platformMessageId: 'tg_1',
      text: '@claude-opus Telegram 问题',
      receivedAt: 1_700_000_000_500,
    });

    expect(wx.threadId).not.toBe(tg.threadId);
    expect(wx.userId).not.toBe(tg.userId);
    // Each thread holds only its own conversation (no cross-contamination).
    const wxHist = await app.stores.messageStore.getByThread(wx.threadId);
    const tgHist = await app.stores.messageStore.getByThread(tg.threadId);
    expect(wxHist.some((m) => m.content.includes('微信问题'))).toBe(true);
    expect(wxHist.some((m) => m.content.includes('Telegram 问题'))).toBe(false);
    expect(tgHist.some((m) => m.content.includes('Telegram 问题'))).toBe(true);
  });
});

describe('submitPlatformMessage degenerate turns do not orphan mappings (adversarial)', () => {
  it('a no-mention message still resolves+persists and reverse-resolves the channel', async () => {
    // No @mention → fallback routing may pick nothing; the mapping + user msg must
    // still be intact and reverse-resolvable (an adapter can still reply later).
    const app = injectApp({ 'claude-opus': [[]] });
    const result = await app.submitPlatformMessage(wechatIncoming('今天的进度怎么样了？'));

    expect(result.threadId).toMatch(/^thread_wechat_/);
    const history = await app.stores.messageStore.getByThread(result.threadId);
    expect(history.some((m) => m.origin === 'user' && m.content.includes('进度'))).toBe(true);
    expect(await app.platformMappingStore.getChannelId('wechat', result.threadId)).toBe(
      WECHAT_CHANNEL,
    );
  });

  it('a provider that throws mid-stream does NOT reject ingress and leaves mappings reusable', async () => {
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'claude-opus': new ThrowingAgentService(CLAUDE) },
    });
    cleanups.push(app.close);

    // First call: provider faults. submitPlatformMessage must still resolve (the
    // pipeline's catch handles it) and persist the user message.
    const first = await app.submitPlatformMessage(wechatIncoming('@claude-opus 跑一下'));
    expect(first.threadId).toMatch(/^thread_wechat_/);
    const hist = await app.stores.messageStore.getByThread(first.threadId);
    expect(hist.some((m) => m.origin === 'user')).toBe(true);

    // Second call from the same channel reuses the SAME thread/user (mapping intact).
    const second = await app.submitPlatformMessage(wechatIncoming('@claude-opus 再试一次'));
    expect(second.threadId).toBe(first.threadId);
    expect(second.userId).toBe(first.userId);
  });

  it('an empty-text inbound message resolves ids and persists an empty user message', async () => {
    // Adapters may forward a non-text platform event normalized to text:''. Ingress
    // must not crash; it persists the (empty) user message and a reusable mapping.
    const app = injectApp({ 'claude-opus': [[]] });
    const result = await app.submitPlatformMessage(wechatIncoming(''));
    expect(result.threadId).toMatch(/^thread_wechat_/);
    const history = await app.stores.messageStore.getByThread(result.threadId);
    expect(history.filter((m) => m.origin === 'user')).toHaveLength(1);
  });
});

describe('submitPlatformMessage routes @mentions through the same router path (adversarial parity)', () => {
  it('a platform @mention invokes the mentioned agent (same path as HTTP)', async () => {
    const app = injectApp({
      'codex-gpt': [replyScript(CODEX, '已按 @claude 的设计实现了 CRUD 接口。')],
    });
    const result = await app.submitPlatformMessage(wechatIncoming('@codex 实现一下这个接口'));
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.agentId).toBe(CODEX);
  });
});

describe('HTTP-vs-ingress behavior parity (adversarial on the refactor)', () => {
  it('the same message via HTTP POST and via submitPlatformMessage persist equivalently', async () => {
    // The dev extracted handleThreadMessage out of message-routes; this asserts the
    // two entry points have not drifted. Same agent script, same content → same
    // shape of persisted records (origin, agentId, mentions, content).
    // Use the real '@claude' mention pattern (agents.yaml) so the user message
    // parses to a non-empty mentions list in BOTH paths — making the mentions
    // parity assertion below load-bearing (not a trivially-equal pair of []s).
    const content = '@claude 帮我评审这个层级上下文的截断顺序';
    const replyText = '截断顺序应为 evidence → coverage → anchors → tombstone → burst。';

    const httpApp = injectApp({ 'claude-opus': [replyScript(CLAUDE, replyText)] });
    const httpThread = 'thread_http_parity';
    const httpRes = await httpApp.api.inject({
      method: 'POST',
      url: `/api/threads/${httpThread}/messages`,
      payload: { content },
    });
    expect(httpRes.statusCode).toBe(200);
    const httpHist = await httpApp.stores.messageStore.getByThread(httpThread);

    const ingressApp = injectApp({ 'claude-opus': [replyScript(CLAUDE, replyText)] });
    const ingressResult = await ingressApp.submitPlatformMessage(wechatIncoming(content));
    const ingressHist = await ingressApp.stores.messageStore.getByThread(ingressResult.threadId);

    // Same number of messages, same ordered (origin, agentId, content) projection.
    const project = (m: StoredMessage): readonly [string, AgentId | null, string] => [
      m.origin ?? 'user',
      m.agentId,
      m.content,
    ];
    expect(ingressHist.map(project)).toEqual(httpHist.map(project));
    // And the user message's parsed mentions match (mention-parsing happens in the
    // shared handler, so both paths must produce the same mentions list).
    const httpUser = httpHist.find((m) => m.origin === 'user');
    const ingressUser = ingressHist.find((m) => m.origin === 'user');
    expect(ingressUser?.mentions).toEqual(httpUser?.mentions);
    expect(ingressUser?.mentions).toContain(CLAUDE);
  });

  it('HTTP and ingress both auto-create the thread + attribute the reply to the agent', async () => {
    const httpApp = injectApp({ 'claude-opus': [replyScript(CLAUDE, '好的，已创建。')] });
    const httpRes = httpApp.api.inject({
      method: 'POST',
      url: '/api/threads/thread_http_create/messages',
      payload: { content: '@claude-opus 新建一个会话' },
    });
    const ingressApp = injectApp({ 'claude-opus': [replyScript(CLAUDE, '好的，已创建。')] });
    const ingressResult = await ingressApp.submitPlatformMessage(
      wechatIncoming('@claude-opus 新建一个会话'),
    );
    expect((await httpRes).statusCode).toBe(200);

    const httpThread = await httpApp.stores.threadStore.get('thread_http_create');
    const ingressThread = await ingressApp.stores.threadStore.get(ingressResult.threadId);
    expect(httpThread).not.toBeNull();
    expect(ingressThread).not.toBeNull();
    expect(ingressResult.replies[0]?.agentId).toBe(CLAUDE);
  });
});

describe('onTextDelta seam is pure-increment (edge + regression on the Phase-2 change)', () => {
  // The dev added an optional `onTextDelta` to HandleThreadMessageInput +
  // submitPlatformMessage. The 飞书 adapter uses it; the HTTP route + the WeChat /
  // Telegram adapters do NOT pass it. These prove the seam is byte-for-byte
  // unchanged when the option is OMITTED, and that — when PASSED — it observes
  // exactly the chunks that compose the persisted reply (no extra, no drop).

  it('[regression] submitPlatformMessage WITHOUT onTextDelta persists/returns IDENTICALLY to WITH it', async () => {
    const replyText = '已收到，正在评估层级上下文的截断策略。';
    const content = '@claude-opus 评估一下截断策略';

    const without = injectApp({ 'claude-opus': [replyScript(CLAUDE, replyText)] });
    const withDelta = injectApp({ 'claude-opus': [replyScript(CLAUDE, replyText)] });

    const r1 = await without.submitPlatformMessage(wechatIncoming(content));
    const seen: string[] = [];
    const r2 = await withDelta.submitPlatformMessage(wechatIncoming(content), {
      onTextDelta: (_agentId, text) => seen.push(text),
    });

    // Same returned replies (agent, content) in both calls — the option is inert to output.
    const project = (rs: StoredMessage[]): ReadonlyArray<readonly [AgentId | null, string]> =>
      rs.map((r) => [r.agentId, r.content] as const);
    expect(project(r2.replies)).toEqual(project(r1.replies));
    expect(r2.replies[0]?.content).toBe(replyText);

    // Same persisted transcript shape (origin, agentId, content) on each thread.
    const projectStored = (m: StoredMessage): readonly [string, AgentId | null, string] => [
      m.origin ?? 'user',
      m.agentId,
      m.content,
    ];
    const h1 = (await without.stores.messageStore.getByThread(r1.threadId)).map(projectStored);
    const h2 = (await withDelta.stores.messageStore.getByThread(r2.threadId)).map(projectStored);
    expect(h2).toEqual(h1);

    // And the sink observed exactly the chunk(s) that compose the reply (replyScript
    // emits the whole reply as ONE text event → the concatenation equals the reply).
    expect(seen.join('')).toBe(replyText);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('[regression] the HTTP POST route still works (it never passes onTextDelta) — proves the seam is opt-in', async () => {
    const replyText = '路由层不传 onTextDelta，行为不变。';
    const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, replyText)] });

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread_http_seam/messages',
      payload: { content: '@claude-opus 这条走 HTTP' },
    });

    expect(res.statusCode).toBe(200);
    const hist = await app.stores.messageStore.getByThread('thread_http_seam');
    const reply = hist.find((m) => m.origin === 'stream');
    expect(reply?.agentId).toBe(CLAUDE);
    expect(reply?.content).toBe(replyText);
  });

  it('[edge] onTextDelta is invoked PER streamed agent with that agent’s own chunks (multi-agent fan-out)', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, 'Claude 的部分。')],
      'codex-gpt': [replyScript(CODEX, 'Codex 的部分。')],
    });

    const byAgent = new Map<AgentId, string>();
    await app.submitPlatformMessage(wechatIncoming('@claude @codex 一起看下'), {
      onTextDelta: (agentId, text) => {
        byAgent.set(agentId, (byAgent.get(agentId) ?? '') + text);
      },
    });

    // Each agent's accumulated deltas equal its own reply — never cross-attributed.
    expect(byAgent.get(CLAUDE)).toBe('Claude 的部分。');
    expect(byAgent.get(CODEX)).toBe('Codex 的部分。');
  });
});
