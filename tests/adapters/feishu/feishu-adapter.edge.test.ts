// M-FEISHU 飞书 adapter inbound core — EDGE + ADVERSARIAL gate (independent QA, dev≠QA §0.5.3).
//
// The load-bearing inbound logic is FeishuAdapter.handleEvent (parse → ingress seam →
// reply each non-empty agent message back to the same chat via the Feishu HTTP API).
// start()/stop() are thin WSClient glue — we NEVER call start() (it opens a real socket).
// A hand-rolled `submitPlatformMessage` stub lets us drive the exact reply set (single,
// multi, empty-content, throwing) with no live pipeline; an injected fetch captures the
// outbound im/v1/messages calls. NO product code modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect } from 'vitest';
import type { AgentId, IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  FeishuAdapter,
  type IngressResult,
  type SubmitPlatformMessage,
  type AdapterLogger,
} from '@choco/adapters/feishu';

const CHAT_ID = 'oc_3f9a2c1b7d8e4f60a1b2c3d4e5f60718';
const MESSAGE_ID = 'om_dc13264520b7c0a3f6e9d2a1b8c7d6e5';
const OPEN_ID = 'ou_84b2f7c9e1a3d5b6c8f0e2a4b6d8c0e2';
const CLAUDE: AgentId = createAgentId('claude-opus');

/** A full im.message.receive_v1 p2p text envelope (the SDK's handler payload). */
function p2pTextEnvelope(text: string): unknown {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: { sender_id: { open_id: OPEN_ID } },
      message: {
        message_id: MESSAGE_ID,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
      },
    },
  };
}

/** A group event (must be ignored — never routed). */
function groupTextEnvelope(text: string): unknown {
  const e = p2pTextEnvelope(text) as { event: { message: { chat_type: string } } };
  e.event.message.chat_type = 'group';
  return e;
}

/** Craft a stored agent reply (the shape submitPlatformMessage returns in `replies`). */
function agentReply(content: string, id: string): StoredMessage {
  return {
    id,
    threadId: 'thr_feishu_1',
    userId: 'claude-opus',
    agentId: CLAUDE,
    content,
    mentions: [],
    origin: 'stream',
    timestamp: Date.now(),
  };
}

interface SentText {
  readonly url: string;
  readonly receiveId: string;
  readonly text: string;
  readonly bearer: string;
}

/** A fetch stub that mints a token then records every im/v1/messages send. */
function makeFetch(sends: SentText[], opts: { failSend?: boolean } = {}): typeof globalThis.fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 'tt-feishu', expire: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('im/v1/messages')) {
      if (opts.failSend === true) {
        return new Response(JSON.stringify({ msg: 'service unavailable' }), { status: 503 });
      }
      const body = JSON.parse(String(init?.body)) as { receive_id: string; content: string };
      const headers = init?.headers as Record<string, string>;
      sends.push({
        url,
        receiveId: body.receive_id,
        text: (JSON.parse(body.content) as { text: string }).text,
        bearer: headers.Authorization,
      });
      return new Response(JSON.stringify({ code: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  }) as typeof globalThis.fetch;
}

/** A submit stub returning a fixed reply set + recording the inbound it was handed. */
function makeSubmit(
  replies: StoredMessage[],
  received: IncomingPlatformMessage[],
): SubmitPlatformMessage {
  return async (incoming: IncomingPlatformMessage): Promise<IngressResult> => {
    received.push(incoming);
    return { threadId: 'thr_feishu_1', userId: 'user_feishu_1', replies };
  };
}

const NOOP_LOGGER: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe('FeishuAdapter.handleEvent — routes valid p2p text and replies (happy + edge)', () => {
  it('[happy] a valid p2p text is routed once and the single agent reply is sent back to the same chat', async () => {
    // Arrange
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([agentReply('已收到，飞书。', 'r1')], received),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    // Act
    await adapter.handleEvent(p2pTextEnvelope('@claude-opus 看下这个排期'));

    // Assert — routed with the normalized inbound; replied to the originating chat.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      adapterName: 'feishu',
      channelId: CHAT_ID,
      platformUserId: OPEN_ID,
      platformMessageId: MESSAGE_ID,
      text: '@claude-opus 看下这个排期',
    });
    expect(sends).toEqual([
      { url: expect.stringContaining('im/v1/messages'), receiveId: CHAT_ID, text: '已收到，飞书。', bearer: 'Bearer tt-feishu' },
    ]);
  });

  it('[edge] multiple agent replies are each sent back in order', async () => {
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit(
        [agentReply('第一段：先看结论。', 'r1'), agentReply('第二段：再看依据。', 'r2')],
        received,
      ),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    await adapter.handleEvent(p2pTextEnvelope('多段回复也要都发出去'));

    expect(sends.map((s) => s.text)).toEqual(['第一段：先看结论。', '第二段：再看依据。']);
  });

  it('[edge] an empty-content reply is SKIPPED (only non-empty replies are sent)', async () => {
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit(
        [agentReply('', 'empty'), agentReply('这条非空，应被发送。', 'r2')],
        received,
      ),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    await adapter.handleEvent(p2pTextEnvelope('跳过空回复'));

    // Only the non-empty reply crossed the wire.
    expect(sends.map((s) => s.text)).toEqual(['这条非空，应被发送。']);
  });
});

describe('FeishuAdapter.handleEvent — ignores non-routable events (edge + adversarial)', () => {
  it('[edge] a group event is NOT routed and NOTHING is sent', async () => {
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([agentReply('不该发出', 'r1')], received),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    await adapter.handleEvent(groupTextEnvelope('群消息别触发'));

    expect(received).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('[edge] a malformed payload (null) is a no-op (no route, no send, resolves)', async () => {
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([], received),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    await expect(adapter.handleEvent(null)).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });

  it('[adversarial] a submit that THROWS is caught + logged — handleEvent resolves (no unhandled rejection)', async () => {
    const sends: SentText[] = [];
    const errors: string[] = [];
    const logger: AdapterLogger = {
      ...NOOP_LOGGER,
      error: (ctx) => errors.push(String(ctx.err)),
    };
    const adapter = new FeishuAdapter({
      submitPlatformMessage: async () => {
        throw new Error('ingress pipeline exploded');
      },
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
      logger,
    });

    // The throw must be swallowed: the promise resolves, no send happened, the error logged.
    await expect(adapter.handleEvent(p2pTextEnvelope('会让 submit 抛错'))).resolves.toBeUndefined();
    expect(sends).toHaveLength(0);
    expect(errors.some((e) => e.includes('ingress pipeline exploded'))).toBe(true);
  });

  it('[adversarial] a send that THROWS (503) is caught + logged — handleEvent resolves', async () => {
    const sends: SentText[] = [];
    const received: IncomingPlatformMessage[] = [];
    const errors: string[] = [];
    const logger: AdapterLogger = {
      ...NOOP_LOGGER,
      error: (ctx) => errors.push(String(ctx.err)),
    };
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([agentReply('这条发送会 503', 'r1')], received),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends, { failSend: true }),
      logger,
    });

    await expect(adapter.handleEvent(p2pTextEnvelope('发送失败也别崩'))).resolves.toBeUndefined();
    expect(received).toHaveLength(1); // it WAS routed
    expect(errors.some((e) => e.includes('503'))).toBe(true);
  });
});

describe('FeishuAdapter — lifecycle + outbound without a live socket (edge)', () => {
  it('[edge] stop() without ever calling start() is a safe no-op (resolves, stays disconnected)', async () => {
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([], []),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch([]),
    });

    expect(adapter.isConnected).toBe(false);
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.isConnected).toBe(false);
  });

  it('[edge] sendMessage mints a token then POSTs the text to the given chat with the Bearer header', async () => {
    const sends: SentText[] = [];
    const adapter = new FeishuAdapter({
      submitPlatformMessage: makeSubmit([], []),
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'secret_kP9',
      fetchFn: makeFetch(sends),
    });

    await adapter.sendMessage(CHAT_ID, '直接调用 sendMessage 的外发');

    expect(sends).toEqual([
      {
        url: expect.stringContaining('im/v1/messages?receive_id_type=chat_id'),
        receiveId: CHAT_ID,
        text: '直接调用 sendMessage 的外发',
        bearer: 'Bearer tt-feishu',
      },
    ]);
  });
});
