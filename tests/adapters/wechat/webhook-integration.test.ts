// M13 WeChat adapter — integration happy-path (reachability) suite (DEV role).
// QA owns edge + adversarial coverage (bad signature, retries, errcode, dedup).
//
// Proves the FROZEN inbound→ingress→outbound path end-to-end (CLAUDE §3.4):
//   real buildApp({ db: :memory: }) + Fake provider + the WeChat adapter wired
//   with a FAKE outbound sender. We POST a realistic WeChat XML envelope to
//   /api/adapters/wechat/webhook (via Fastify inject — no real socket), then
//   assert: a thread/user resolved through the A10 mapping store, the message
//   routed through the pipeline, and the adapter pushed the agent reply back to
//   the SAME channel via the outbound sender. Real OpenId/CJK/XML — no placeholders.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { createWeChatAdapter, type OutboundSender } from '@clowder/adapters/wechat';
import { replyScript, CLAUDE } from '../../api/helpers.js';
import { FakeAgentService } from '../../invocation/fake-agent-service.js';

const SENDER_OPENID = 'oWxYz09876543210abcdEFghIJklmn';
const OFFICIAL_ACCOUNT = 'gh_7f3a9c2e1b08';

// Config carries no real secrets; token is empty → plaintext mode (no signature
// check), since the outbound sender is faked and never hits the network.
const CONFIG = {
  corpId: 'ww1a2b3c4d5e6f7g8',
  secret: 'fake-secret-not-used-with-fake-sender',
  token: '',
  apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
} as const;

interface SentChunk {
  readonly channelId: string;
  readonly content: string;
  readonly agentId?: AgentId;
}

function buildWeChatXml(text: string, msgId: string): string {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
    `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${text}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

function injectApp(
  scripts: Record<string, readonly (readonly AgentMessage[])[]>,
): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db, agentServices: fakes });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('WeChat webhook (integration happy path)', () => {
  it('routes an inbound XML message and sends the agent reply back to the channel', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '已收到，正在评估数据库选型。')],
    });
    cleanups.push(app.close);

    const sent: SentChunk[] = [];
    const fakeSender: OutboundSender = async (channelId, content, agentId) => {
      sent.push({ channelId, content, ...(agentId !== undefined ? { agentId } : {}) });
    };

    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: fakeSender,
    });
    await adapter.start();
    await app.api.ready();

    const response = await app.api.inject({
      method: 'POST',
      url: '/api/adapters/wechat/webhook',
      headers: { 'content-type': 'text/xml' },
      payload: buildWeChatXml('@claude-opus 帮我评估一下 Postgres 还是 SQLite', '2001'),
    });

    expect(response.statusCode).toBe(200);

    // The agent reply was pushed back to the SAME platform channel (the sender OpenId).
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(SENDER_OPENID);
    expect(sent[0]?.content).toBe('已收到，正在评估数据库选型。');
    expect(sent[0]?.agentId).toBe(CLAUDE);
  });

  it('resolves the platform channel to an internal thread via the A10 mapping store', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '建议先看读写比例再定。')],
    });
    cleanups.push(app.close);

    const fakeSender: OutboundSender = async () => {};
    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: fakeSender,
    });
    await adapter.start();
    await app.api.ready();

    await app.api.inject({
      method: 'POST',
      url: '/api/adapters/wechat/webhook',
      headers: { 'content-type': 'text/xml' },
      payload: buildWeChatXml('@claude-opus 选型建议？', '2002'),
    });

    // A10 reverse lookup: the sender's channel maps to a resolved internal thread.
    const threadId = await app.platformMappingStore.resolveThread('wechat', SENDER_OPENID);
    expect(threadId).toMatch(/^thread_wechat_/);

    const history = await app.stores.messageStore.getByThread(threadId);
    expect(history).toHaveLength(2); // inbound user message + one agent reply
    const userMsg = history.find((m) => m.origin === 'user');
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(userMsg?.content).toBe('@claude-opus 选型建议？');
    expect(replyMsg?.agentId).toBe(CLAUDE);
  });

  it('splits a multi-sentence reply into sentence-level chunks (§B4 buffering)', async () => {
    const app = injectApp({
      'claude-opus': [
        replyScript(CLAUDE, '第一步先确认读写比例。第二步评估并发量。第三步再选型。'),
      ],
    });
    cleanups.push(app.close);

    const sent: SentChunk[] = [];
    const fakeSender: OutboundSender = async (channelId, content) => {
      sent.push({ channelId, content });
    };
    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: fakeSender,
    });
    await adapter.start();
    await app.api.ready();

    await app.api.inject({
      method: 'POST',
      url: '/api/adapters/wechat/webhook',
      headers: { 'content-type': 'text/xml' },
      payload: buildWeChatXml('@claude-opus 给个分步建议', '2003'),
    });

    // Three sentence terminators (。) → three chunks, all to the same channel.
    expect(sent).toHaveLength(3);
    expect(sent.map((c) => c.content)).toEqual([
      '第一步先确认读写比例。',
      '第二步评估并发量。',
      '第三步再选型。',
    ]);
    expect(sent.every((c) => c.channelId === SENDER_OPENID)).toBe(true);
  });

  it('answers the GET URL-verification echo when no token is configured', async () => {
    const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, 'ok')] });
    cleanups.push(app.close);

    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: async () => {},
    });
    await adapter.start();
    await app.api.ready();

    const echo = 'echo-challenge-123456';
    const response = await app.api.inject({
      method: 'GET',
      url: `/api/adapters/wechat/webhook?echostr=${echo}&timestamp=1700000000&nonce=abc`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(echo);
  });
});
