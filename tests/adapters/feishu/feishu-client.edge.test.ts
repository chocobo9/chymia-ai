// M-FEISHU 飞书/Lark HTTP surface — EDGE + ADVERSARIAL gate (independent QA, dev≠QA §0.5.3).
//
// The dev shipped feishu-client.ts (parseFeishuEvent / FeishuTokenCache / sendFeishuText)
// and a happy-path proof in tests/api/feishu-wiring.test.ts. This file is the rejection
// surface: every parse-reject branch (wrong event_type, group, non-text, missing ids,
// malformed content JSON, empty text), the token cache's TTL/refresh/HTTP/code-error
// behaviour (asserting fetch call COUNT so a stale token is never re-minted), and the
// send endpoint's URL/body/header contract + its error throws. Injected fetch + a fake
// `now` clock — no network, no real socket. NO product code modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect } from 'vitest';
import {
  parseFeishuEvent,
  FeishuTokenCache,
  sendFeishuText,
} from '@choco/adapters/feishu';

// ── Realistic Feishu shapes ─────────────────────────────────────────────────
// cli_ app id, ou_/oc_/om_ open-id prefixes, real CJK DM text — no placeholder data.
const CHAT_ID = 'oc_3f9a2c1b7d8e4f60a1b2c3d4e5f60718';
const MESSAGE_ID = 'om_dc13264520b7c0a3f6e9d2a1b8c7d6e5';
const OPEN_ID = 'ou_84b2f7c9e1a3d5b6c8f0e2a4b6d8c0e2';

/** The full `{ header, event }` envelope the SDK hands an im.message.receive_v1 handler. */
function p2pTextEnvelope(text: string): unknown {
  return {
    schema: '2.0',
    header: {
      event_id: 'f7c9e1a3d5b6c8f0e2a4b6d8c0e21234',
      event_type: 'im.message.receive_v1',
      token: 'v_token_opaque',
      app_id: 'cli_a1b2c3d4e5f60718',
      tenant_key: 'tk_736588c1259f0c19',
    },
    event: {
      sender: {
        sender_id: { open_id: OPEN_ID, union_id: 'on_union_abc', user_id: 'usr_001' },
        sender_type: 'user',
      },
      message: {
        message_id: MESSAGE_ID,
        chat_id: CHAT_ID,
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text }),
        create_time: '1717459200000',
      },
    },
  };
}

/** The inner event ONLY (the SDK may pass this directly, without the `{header,event}` wrap). */
function innerP2pTextEvent(text: string): unknown {
  return {
    sender: { sender_id: { open_id: OPEN_ID } },
    message: {
      message_id: MESSAGE_ID,
      chat_id: CHAT_ID,
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text }),
    },
  };
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseFeishuEvent — accepts p2p text (happy)', () => {
  it('[happy] extracts chatId/text/messageId/senderId from a full {header,event} envelope', () => {
    // Arrange
    const envelope = p2pTextEnvelope('帮我看看这个 PR 的并发模型有没有问题');

    // Act
    const inbound = parseFeishuEvent(envelope);

    // Assert
    expect(inbound).toEqual({
      chatId: CHAT_ID,
      text: '帮我看看这个 PR 的并发模型有没有问题',
      messageId: MESSAGE_ID,
      senderId: OPEN_ID,
    });
  });

  it('[edge] parses a payload WITHOUT a header (the bare inner event) the same way', () => {
    const inbound = parseFeishuEvent(innerP2pTextEvent('直接传内层 event 也要能解析'));
    expect(inbound).toEqual({
      chatId: CHAT_ID,
      text: '直接传内层 event 也要能解析',
      messageId: MESSAGE_ID,
      senderId: OPEN_ID,
    });
  });

  it('[edge] preserves CJK, emoji, and newlines in the text verbatim', () => {
    const text = '排期问题 🗓️\n第一行\n第二行——别 trim 我';
    const inbound = parseFeishuEvent(p2pTextEnvelope(text));
    expect(inbound?.text).toBe(text);
  });
});

describe('parseFeishuEvent — rejects everything that is not a p2p text message (edge + adversarial)', () => {
  it('[edge] a non-message header event_type → null', () => {
    const envelope = p2pTextEnvelope('忽略我');
    (envelope as { header: { event_type: string } }).header.event_type =
      'im.chat.member.user.added_v1';
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[edge] a group chat_type → null (MVP is DM only)', () => {
    const envelope = p2pTextEnvelope('群里别触发') as {
      event: { message: { chat_type: string } };
    };
    envelope.event.message.chat_type = 'group';
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[edge] an unknown chat_type → null', () => {
    const envelope = p2pTextEnvelope('未知会话类型') as {
      event: { message: { chat_type: string } };
    };
    envelope.event.message.chat_type = 'topic_group';
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[edge] a non-text message_type (image) → null', () => {
    const envelope = p2pTextEnvelope('图片消息') as {
      event: { message: { message_type: string } };
    };
    envelope.event.message.message_type = 'image';
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[edge] a missing event object (header only) → null', () => {
    expect(parseFeishuEvent({ header: { event_type: 'im.message.receive_v1' } })).toBeNull();
  });

  it('[edge] a missing message object → null', () => {
    expect(
      parseFeishuEvent({
        header: { event_type: 'im.message.receive_v1' },
        event: { sender: { sender_id: { open_id: OPEN_ID } } },
      }),
    ).toBeNull();
  });

  it('[edge] a missing chat_id → null', () => {
    const envelope = p2pTextEnvelope('没有 chat_id') as {
      event: { message: { chat_id?: string } };
    };
    delete envelope.event.message.chat_id;
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[edge] a missing message_id → null', () => {
    const envelope = p2pTextEnvelope('没有 message_id') as {
      event: { message: { message_id?: string } };
    };
    delete envelope.event.message.message_id;
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[adversarial] a malformed content JSON string → null (never throws)', () => {
    const envelope = p2pTextEnvelope('被覆盖') as {
      event: { message: { content: string } };
    };
    envelope.event.message.content = '{"text": "未闭合的引号';
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[adversarial] content whose JSON has no text key → null', () => {
    const envelope = p2pTextEnvelope('被覆盖') as {
      event: { message: { content: string } };
    };
    envelope.event.message.content = JSON.stringify({ image_key: 'img_v2_abc' });
    expect(parseFeishuEvent(envelope)).toBeNull();
  });

  it('[adversarial] an empty text → null (an empty DM is not a real message)', () => {
    expect(parseFeishuEvent(p2pTextEnvelope(''))).toBeNull();
  });

  it('[adversarial] a non-object payload (null / string / number) → null', () => {
    expect(parseFeishuEvent(null)).toBeNull();
    expect(parseFeishuEvent('not an event')).toBeNull();
    expect(parseFeishuEvent(42)).toBeNull();
    expect(parseFeishuEvent(undefined)).toBeNull();
  });

  it('[edge] a missing sender falls back to senderId "unknown" (still a valid inbound)', () => {
    const envelope = p2pTextEnvelope('匿名也要能收到') as {
      event: { sender?: unknown };
    };
    delete envelope.event.sender;
    const inbound = parseFeishuEvent(envelope);
    expect(inbound).toEqual({
      chatId: CHAT_ID,
      text: '匿名也要能收到',
      messageId: MESSAGE_ID,
      senderId: 'unknown',
    });
  });

  it('[edge] a sender present but without open_id → senderId "unknown"', () => {
    const envelope = p2pTextEnvelope('有 sender 没 open_id') as {
      event: { sender: { sender_id: Record<string, unknown> } };
    };
    envelope.event.sender.sender_id = { union_id: 'on_union_only' };
    expect(parseFeishuEvent(envelope)?.senderId).toBe('unknown');
  });
});

describe('FeishuTokenCache — caches within TTL, refreshes when expired (edge + adversarial)', () => {
  it('[edge] a second get() within the TTL does NOT re-fetch (asserts fetch call count == 1)', async () => {
    // Arrange — a clock fixed in time so the cached token never expires between calls.
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({ code: 0, tenant_access_token: 't-cached-001', expire: 7200 });
    }) as typeof globalThis.fetch;
    const cache = new FeishuTokenCache('cli_a1b2c3d4e5f60718', 'secret_kP9', fetchFn, () => 1_000_000);

    // Act
    const first = await cache.get();
    const second = await cache.get();

    // Assert — the second call is served from cache, not the wire.
    expect(first).toBe('t-cached-001');
    expect(second).toBe('t-cached-001');
    expect(calls).toBe(1);
  });

  it('[edge] an expired token re-fetches via an advancing now clock (call count == 2, new token)', async () => {
    // Arrange — expire:7200s, refresh 5min early → valid window ≈ 6900s = 6_900_000ms.
    let now = 0;
    let calls = 0;
    const tokens = ['t-first-window', 't-second-window'];
    const fetchFn = (async () => {
      const token = tokens[calls] ?? 'overflow';
      calls += 1;
      return jsonResponse({ code: 0, tenant_access_token: token, expire: 7200 });
    }) as typeof globalThis.fetch;
    const cache = new FeishuTokenCache('cli_a1b2c3d4e5f60718', 'secret_kP9', fetchFn, () => now);

    // Act
    const first = await cache.get();
    now = 7_000_000; // past the (7200-300)*1000 = 6_900_000ms refresh boundary
    const second = await cache.get();

    // Assert
    expect(first).toBe('t-first-window');
    expect(second).toBe('t-second-window');
    expect(calls).toBe(2);
  });

  it('[adversarial] an HTTP 500 from the token endpoint throws (fail-loud, no silent empty token)', async () => {
    const fetchFn = (async () =>
      jsonResponse({ msg: 'internal error' }, 500)) as typeof globalThis.fetch;
    const cache = new FeishuTokenCache('cli_a1b2c3d4e5f60718', 'secret_kP9', fetchFn);
    await expect(cache.get()).rejects.toThrow(/HTTP 500/);
  });

  it('[adversarial] a non-zero Feishu code (99991663 app_ticket invalid) throws with the code + msg', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        code: 99991663,
        msg: 'app ticket invalid',
        tenant_access_token: 'should-be-ignored',
      })) as typeof globalThis.fetch;
    const cache = new FeishuTokenCache('cli_a1b2c3d4e5f60718', 'secret_kP9', fetchFn);
    await expect(cache.get()).rejects.toThrow(/99991663/);
  });

  it('[adversarial] a 200 OK with code:0 but NO tenant_access_token throws (never caches undefined)', async () => {
    const fetchFn = (async () =>
      jsonResponse({ code: 0, expire: 7200 })) as typeof globalThis.fetch;
    const cache = new FeishuTokenCache('cli_a1b2c3d4e5f60718', 'secret_kP9', fetchFn);
    await expect(cache.get()).rejects.toThrow(/no token/);
  });
});

describe('sendFeishuText — endpoint/body/header contract + error throws (edge + adversarial)', () => {
  it('[happy] POSTs im/v1/messages?receive_id_type=chat_id with the exact body + Bearer header', async () => {
    // Arrange — capture the single outbound call.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ code: 0, data: { message_id: 'om_sent_001' } });
    }) as typeof globalThis.fetch;

    // Act
    await sendFeishuText(fetchFn, 't-bearer-XYZ', CHAT_ID, '已收到，正在处理你的请求。');

    // Assert — URL carries receive_id_type=chat_id.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toContain('/im/v1/messages?receive_id_type=chat_id');
    // Method + Authorization Bearer header.
    expect(call?.init?.method).toBe('POST');
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer t-bearer-XYZ');
    // Exact body: receive_id, msg_type:text, content is a JSON string {text}.
    const body = JSON.parse(String(call?.init?.body)) as {
      receive_id: string;
      msg_type: string;
      content: string;
    };
    expect(body).toEqual({
      receive_id: CHAT_ID,
      msg_type: 'text',
      content: JSON.stringify({ text: '已收到，正在处理你的请求。' }),
    });
  });

  it('[adversarial] an HTTP 502 from the send endpoint throws', async () => {
    const fetchFn = (async () =>
      jsonResponse({ msg: 'bad gateway' }, 502)) as typeof globalThis.fetch;
    await expect(sendFeishuText(fetchFn, 't', CHAT_ID, '会失败的回复')).rejects.toThrow(
      /HTTP 502/,
    );
  });

  it('[adversarial] a non-zero code (230002 bot not in chat) on a 200 OK throws with the code', async () => {
    const fetchFn = (async () =>
      jsonResponse({ code: 230002, msg: 'bot is not in the chat' })) as typeof globalThis.fetch;
    await expect(sendFeishuText(fetchFn, 't', CHAT_ID, '机器人不在会话里')).rejects.toThrow(
      /230002/,
    );
  });
});
