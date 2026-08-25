// QA gating suite (dev≠QA, §0.5.3): §C unavailable-agent NOTICE surfacing.
//
// Independently authored. The dogfooding bug: an explicit @mention of an agent
// whose CLI is not installed produced NO response and NO error — silence. The fix
// surfaces a VISIBLE notice naming the disabled agent + the ACTUAL available
// alternatives, which is (1) broadcast live as a `system_info` agent_event, (2)
// persisted as a `system`-origin StoredMessage, and (3) returned among the turn's
// replies (so the silent-HTTP finding is resolved and an adapter relays it too).
//
// These drive the REAL pipeline (handleThreadMessage via POST + submitPlatformMessage)
// over an in-memory db with codex/gemini marked UNavailable via buildApp's
// `agentAvailability` seam and a Fake provider at the designed boundary. The live
// broadcast is captured over a REAL socket.io client (the startTestApp idiom).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AgentId, AgentMessage, StoredMessage, IncomingPlatformMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, CODEX, replyScript } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

interface NoticeApp {
  readonly app: BuiltApp;
  readonly fakes: Record<string, FakeAgentService>;
}

/** Build an inject-able app with availability injected + a Fake provider per agent. */
function buildNoticeApp(
  availability: Readonly<Record<string, boolean>>,
  scripts: Record<string, readonly (readonly AgentMessage[])[]> = {},
): NoticeApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {
    'claude-opus': new FakeAgentService(scripts['claude-opus'] ?? []),
    'codex-gpt': new FakeAgentService(scripts['codex-gpt'] ?? []),
    'gemini-pro': new FakeAgentService(scripts['gemini-pro'] ?? []),
    // F215 relay cat (claude-opus-relay): a new roster member. These notice tests
    // focus on the original 3 agents' alternatives logic; the relay cat is a system
    //接班 target, not a user-facing notice alternative, so it is marked UNavailable
    // here (and given a Fake so it never real-spawns even if routed).
    'claude-opus-relay': new FakeAgentService(scripts['claude-opus-relay'] ?? []),
  };
  const app = buildApp({
    db,
    agentServices: fakes,
    agentAvailability: { 'claude-opus-relay': false, ...availability },
  });
  cleanups.push(app.close);
  return { app, fakes };
}

/** claude available, codex + gemini UNavailable. */
const CLAUDE_ONLY = { 'claude-opus': true, 'codex-gpt': false, 'gemini-pro': false };

/** POST one message through the real HTTP route, returning the replies. */
async function postMessage(
  app: BuiltApp,
  threadId: string,
  content: string,
): Promise<{ statusCode: number; replies: StoredMessage[] }> {
  const res = await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content },
  });
  const body = res.json<{ replies: StoredMessage[] }>();
  return { statusCode: res.statusCode, replies: body.replies };
}

describe('§C unavailable-agent notice — text + alternatives', () => {
  it('happy: explicit @codex (unavailable) → a notice naming Codex + listing the AVAILABLE alternative (@claude)', async () => {
    const { app } = buildNoticeApp(CLAUDE_ONLY);
    const { replies } = await postMessage(app, 'thread-notice-codex', '@codex 帮我把这段并发池改成可配置上限');

    // The notice is returned as the first reply (it explains what was skipped).
    const notice = replies[0];
    expect(notice).toBeDefined();
    expect(notice?.origin).toBe('system');
    expect(notice?.agentId).toBe(CODEX);
    // Names the unavailable agent (its displayName) + the CLI-detection reason.
    expect(notice?.content).toContain('Codex');
    expect(notice?.content).toContain('未检测到 CLI');
    // Lists the actually-available alternative — claude's primary @mention.
    expect(notice?.content).toContain('@claude');
    // Does NOT offer the other unavailable agent as an alternative.
    expect(notice?.content).not.toContain('@gemini');
  });

  it('adversarial: the alternatives are the ACTUAL available set, not hardcoded (gemini up, claude+codex down)', async () => {
    // Flip availability: only gemini is up. An explicit @codex notice must offer
    // @gemini (the real alternative), proving the list is derived, not a constant.
    const { app } = buildNoticeApp({
      'claude-opus': false,
      'codex-gpt': false,
      'gemini-pro': true,
    });
    const { replies } = await postMessage(app, 'thread-notice-alt', '@codex 你来实现这个脚本');
    const notice = replies.find((r) => r.origin === 'system');
    expect(notice).toBeDefined();
    expect(notice?.content).toContain('Codex');
    expect(notice?.content).toContain('@gemini');
    expect(notice?.content).not.toContain('@claude');
  });

  it('adversarial: when NO agent is available, the notice says so instead of listing fake alternatives', async () => {
    const { app } = buildNoticeApp({
      'claude-opus': false,
      'codex-gpt': false,
      'gemini-pro': false,
    });
    const { replies } = await postMessage(app, 'thread-notice-none', '@codex 在吗');
    const notice = replies.find((r) => r.origin === 'system');
    expect(notice).toBeDefined();
    expect(notice?.content).toContain('当前无可用 agent');
    // No spurious @mention alternatives appended.
    expect(notice?.content).not.toContain('可用：@');
  });

  it('edge: multiple unavailable mentions (@codex @gemini) name BOTH in one notice', async () => {
    const { app } = buildNoticeApp(CLAUDE_ONLY);
    const { replies } = await postMessage(app, 'thread-notice-both', '@codex @gemini 你们俩谁先来');
    const notice = replies.find((r) => r.origin === 'system');
    expect(notice).toBeDefined();
    expect(notice?.content).toContain('Codex');
    expect(notice?.content).toContain('Gemini');
    expect(notice?.content).toContain('@claude'); // the only available alternative
  });
});

describe('§C notice — persisted + returned in replies + NOT spawning', () => {
  it('edge: the notice is PERSISTED as a system-origin message (survives a reload via getByThread)', async () => {
    const { app } = buildNoticeApp(CLAUDE_ONLY);
    const threadId = 'thread-notice-persist';
    await postMessage(app, threadId, '@codex 把重试逻辑补上');

    const history = await app.stores.messageStore.getByThread(threadId);
    const systemMsg = history.find((m) => m.origin === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg?.agentId).toBe(CODEX);
    expect(systemMsg?.content).toContain('Codex');
    // The user message is also persisted (the turn was not dropped).
    expect(history.some((m) => m.origin === 'user')).toBe(true);
  });

  it('edge: an explicit @codex spawns NO codex turn (the FakeService is never invoked) — no silent spawn-fail', async () => {
    const { app, fakes } = buildNoticeApp(CLAUDE_ONLY, {
      'codex-gpt': [replyScript(CODEX, '不应被调用')],
    });
    await postMessage(app, 'thread-notice-nospawn', '@codex 帮我跑一下迁移脚本');
    // The codex Fake provider must never have been invoked.
    expect(fakes['codex-gpt']?.calls).toHaveLength(0);
  });

  it('edge: a mixed @claude @codex turn ROUTES to claude AND returns the codex notice', async () => {
    const { app, fakes } = buildNoticeApp(CLAUDE_ONLY, {
      'claude-opus': [replyScript(CLAUDE, '我来定架构并实现。')],
      'codex-gpt': [replyScript(CODEX, '不应被调用')],
    });
    const { replies } = await postMessage(
      app,
      'thread-notice-mixed',
      '@claude 你定架构，@codex 你来实现',
    );

    // claude actually ran.
    expect(fakes['claude-opus']?.calls.length).toBeGreaterThanOrEqual(1);
    expect(fakes['codex-gpt']?.calls).toHaveLength(0);

    // Replies include BOTH the system notice (for codex) and claude's reply.
    const notice = replies.find((r) => r.origin === 'system');
    const claudeReply = replies.find((r) => r.origin === 'stream' && r.agentId === CLAUDE);
    expect(notice?.content).toContain('Codex');
    expect(claudeReply?.content).toBe('我来定架构并实现。');
  });

  it('adversarial: an all-available @claude turn yields NO notice (no false positive)', async () => {
    const { app } = buildNoticeApp(
      { 'claude-opus': true, 'codex-gpt': true, 'gemini-pro': true },
      { 'claude-opus': [replyScript(CLAUDE, '收到，开始实现。')] },
    );
    const { replies } = await postMessage(app, 'thread-no-notice', '@claude 实现 TODO API');
    expect(replies.some((r) => r.origin === 'system')).toBe(false);
    expect(replies.some((r) => r.origin === 'stream' && r.agentId === CLAUDE)).toBe(true);
  });

  it('adversarial: a no-mention message yields NO notice even though codex/gemini are down', async () => {
    // The notice fires only on an EXPLICIT mention of an unavailable agent. A
    // no-mention message routes to the default-available claude with no notice.
    const { app } = buildNoticeApp(CLAUDE_ONLY, {
      'claude-opus': [replyScript(CLAUDE, '我来处理。')],
    });
    const { replies } = await postMessage(app, 'thread-no-mention-notice', '帮我看看这个 bug');
    expect(replies.some((r) => r.origin === 'system')).toBe(false);
  });
});

describe('§C platform ingress (M13/M14 adapters) also relays the notice', () => {
  it('edge: submitPlatformMessage returns the codex notice among its replies (not silence)', async () => {
    const { app } = buildNoticeApp(CLAUDE_ONLY);
    const incoming: IncomingPlatformMessage = {
      adapterName: 'telegram',
      channelId: '-1001234567890',
      platformUserId: '987654321',
      platformMessageId: 'tg_42',
      text: '@codex 把这个 CI 修一下',
      receivedAt: 1_700_000_000_000,
    };
    const result = await app.submitPlatformMessage(incoming);
    const notice = result.replies.find((r) => r.origin === 'system');
    expect(notice).toBeDefined();
    expect(notice?.content).toContain('Codex');
    expect(notice?.content).toContain('@claude');
  });
});

// ===========================================================================
// §C live broadcast — captured over a REAL socket.io client
// ===========================================================================

/** Start the notice app on an ephemeral port so a socket.io client can connect. */
async function listen(notice: NoticeApp): Promise<string> {
  const address = await notice.app.api.listen({ port: 0, host: '127.0.0.1' });
  return typeof address === 'string' ? address : `http://127.0.0.1`;
}

/** Connect + join a thread room (mirrors tests/api/helpers connectClient). */
async function connectClient(baseUrl: string, threadId: string): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => {
      socket.emit('join_thread', { threadId });
      setTimeout(resolve, 30);
    });
    socket.on('connect_error', reject);
  });
  return socket;
}

describe('§C notice is BROADCAST live as a system_info agent_event', () => {
  it('edge: a joined client receives a system_info frame naming Codex over the socket', async () => {
    const notice = buildNoticeApp(CLAUDE_ONLY);
    const baseUrl = await listen(notice);
    const threadId = 'thread-notice-broadcast';
    const client = await connectClient(baseUrl, threadId);
    cleanups.push(() => {
      client.disconnect();
      return Promise.resolve();
    });

    const received: AgentMessage[] = [];
    const got = new Promise<void>((resolve) => {
      client.on('agent_event', (msg: AgentMessage) => {
        received.push(msg);
        if (msg.type === 'system_info') resolve();
      });
      // Safety net so the test fails loud (not hangs) if no frame arrives.
      setTimeout(resolve, 1500);
    });

    await notice.app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@codex 帮我把这个接口的分页补上' },
    });
    await got;

    const systemInfo = received.find((m) => m.type === 'system_info');
    expect(systemInfo).toBeDefined();
    expect(systemInfo?.agentId).toBe(CODEX as AgentId);
    expect(systemInfo?.content).toContain('Codex');
    expect(systemInfo?.content).toContain('@claude');
  });
});
