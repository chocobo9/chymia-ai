// tests/adapters/weixin/ilink-client.edge.test.ts — M14b iLink protocol client
// EDGE + ADVERSARIAL gate. Authored by the INDEPENDENT QA instance (dev≠QA, §0.5.3):
// the dev shipped the happy-path parse in weixin-wiring.test.ts; this file hammers the
// protocol-decoder seams that gate the whole adapter — every QrStatus encoding, the
// HTTP/errcode/network failure surfaces, the parseUpdates skip rules + cursor fallback,
// and the exact sendmessage body shape. Pure-HTTP unit tests over a fake fetch; NO
// product code modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect } from 'vitest';
import {
  parseUpdates,
  pollQrCodeStatus,
  fetchQrCode,
  getUpdates,
  sendText,
  ERRCODE_SESSION_EXPIRED,
  type FetchFn,
} from '@choco/adapters/weixin';

/** A 200 JSON Response (the iLink gateway always 200s on app-level errors via errcode). */
function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A non-2xx Response (a transport/gateway failure, NOT an app-level errcode). */
function httpFail(status: number): Response {
  return new Response('upstream down', { status });
}

/** A fetch that always returns `res` regardless of url. */
function constFetch(res: Response): FetchFn {
  return (async () => res) as FetchFn;
}

/** A fetch that throws (DNS/connection refused) — never resolves a Response. */
const throwingFetch: FetchFn = (async () => {
  throw new Error('ECONNREFUSED ilinkai.weixin.qq.com:443');
}) as FetchFn;

// ---------------------------------------------------------------------------
// parseUpdates — the pure decoder. errcode handling, skip rules, cursor fallback.
// ---------------------------------------------------------------------------
describe('parseUpdates — errcode handling (edge + adversarial)', () => {
  it('[edge] errcode -14 (ERRCODE_SESSION_EXPIRED) sets sessionExpired:true and keeps the prev cursor', () => {
    // Arrange — the gateway signals the bot_token died mid-poll.
    const raw = { errcode: ERRCODE_SESSION_EXPIRED, errmsg: 'token expired' };

    // Act
    const result = parseUpdates(raw, 'cursor-prev');

    // Assert — flagged, no messages, cursor not advanced.
    expect(result.sessionExpired).toBe(true);
    expect(result.messages).toHaveLength(0);
    expect(result.newCursor).toBe('cursor-prev');
  });

  it('[edge] -14 surfaced via the `ret` alias (not `errcode`) also flags sessionExpired', () => {
    // Arrange — iLink uses `ret` and `errcode` interchangeably for the same code.
    const result = parseUpdates({ ret: ERRCODE_SESSION_EXPIRED }, 'c-keep');

    // Assert
    expect(result.sessionExpired).toBe(true);
    expect(result.newCursor).toBe('c-keep');
  });

  it('[adversarial] a NON-expiry errcode (e.g. -1 rate-limited) yields empty messages and does NOT throw', () => {
    // Arrange — a transient app error must degrade to "no messages", never crash the loop.
    const raw = { errcode: -1, errmsg: 'rate limited', msgs: [{ from_user_id: 'u', context_token: 'c', item_list: [{ type: 1, text_item: { text: '应被丢弃' } }] }] };

    // Act
    const result = parseUpdates(raw, 'cursor-7');

    // Assert — errored batch is dropped wholesale; cursor held; not expired.
    expect(result.sessionExpired).toBe(false);
    expect(result.messages).toHaveLength(0);
    expect(result.newCursor).toBe('cursor-7');
  });
});

describe('parseUpdates — message extraction skip rules (edge + adversarial)', () => {
  it('[edge] a missing `msgs` array yields zero messages (no throw on absent field)', () => {
    const result = parseUpdates({ ret: 0, get_updates_buf: 'c-next' }, 'c-prev');
    expect(result.messages).toHaveLength(0);
    expect(result.newCursor).toBe('c-next');
    expect(result.sessionExpired).toBe(false);
  });

  it('[edge] a non-TEXT item type (image item type 3) is skipped', () => {
    // Arrange — only item type 1 (TEXT) becomes a message; an image item must be dropped.
    const raw = {
      ret: 0,
      msgs: [{ from_user_id: 'wxuser_img', context_token: 'ctx_img', item_list: [{ type: 3, text_item: { text: '[图片]' } }] }],
    };

    // Act + Assert
    expect(parseUpdates(raw, 'c').messages).toHaveLength(0);
  });

  it('[edge] an empty-text TEXT item is skipped (no zero-length message reaches the pipeline)', () => {
    const raw = {
      ret: 0,
      msgs: [{ from_user_id: 'wxuser_empty', context_token: 'ctx_e', item_list: [{ type: 1, text_item: { text: '' } }] }],
    };
    expect(parseUpdates(raw, 'c').messages).toHaveLength(0);
  });

  it('[adversarial] a message missing from_user_id is skipped (cannot route a reply with no chat id)', () => {
    const raw = {
      ret: 0,
      msgs: [{ context_token: 'ctx_orphan', item_list: [{ type: 1, text_item: { text: '谁发的？' } }] }],
    };
    expect(parseUpdates(raw, 'c').messages).toHaveLength(0);
  });

  it('[adversarial] a message missing context_token is skipped (cannot reply without the per-chat token)', () => {
    const raw = {
      ret: 0,
      msgs: [{ from_user_id: 'wxuser_noctx', item_list: [{ type: 1, text_item: { text: '在吗' } }] }],
    };
    expect(parseUpdates(raw, 'c').messages).toHaveLength(0);
  });

  it('[edge] a valid text message among invalid siblings is the ONLY one extracted, in order', () => {
    // Arrange — a realistic mixed batch: one good DM, one image, one orphan.
    const raw = {
      ret: 0,
      get_updates_buf: 'buf-88',
      msgs: [
        { from_user_id: 'wxuser_real', context_token: 'ctx_real', message_id: 5521, create_time_ms: 1717459200000, item_list: [{ type: 1, text_item: { text: '@claude 帮我查下周会议时间' } }] },
        { from_user_id: 'wxuser_img', context_token: 'ctx_img', item_list: [{ type: 3 }] },
        { context_token: 'ctx_orphan', item_list: [{ type: 1, text_item: { text: '无主消息' } }] },
      ],
    };

    // Act
    const result = parseUpdates(raw, 'buf-prev');

    // Assert
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      chatId: 'wxuser_real',
      text: '@claude 帮我查下周会议时间',
      contextToken: 'ctx_real',
      messageId: '5521',
      createdAtMs: 1717459200000,
    });
    expect(result.newCursor).toBe('buf-88');
  });

  it('[edge] missing message_id falls back to a deterministic weixin-<chatId> id', () => {
    const raw = {
      ret: 0,
      msgs: [{ from_user_id: 'wxuser_noid', context_token: 'ctx_x', item_list: [{ type: 1, text_item: { text: '没有 id 的消息' } }] }],
    };
    expect(parseUpdates(raw, 'c').messages[0]?.messageId).toBe('weixin-wxuser_noid');
  });
});

describe('parseUpdates — cursor fallback (edge)', () => {
  it('[edge] cursor falls back to the prev cursor when get_updates_buf is absent', () => {
    // Arrange — a successful empty poll with no advancing buffer must hold position.
    const result = parseUpdates({ ret: 0, msgs: [] }, 'cursor-held');
    expect(result.newCursor).toBe('cursor-held');
  });

  it('[edge] get_updates_buf, when present, advances the cursor past the prev', () => {
    const result = parseUpdates({ ret: 0, get_updates_buf: 'cursor-moved', msgs: [] }, 'cursor-held');
    expect(result.newCursor).toBe('cursor-moved');
  });
});

// ---------------------------------------------------------------------------
// pollQrCodeStatus — every status encoding (numeric + string) and every failure.
// ---------------------------------------------------------------------------
describe('pollQrCodeStatus — numeric status encodings (edge)', () => {
  it('[edge] numeric status 0 → waiting', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 0 })), 'QP');
    expect(status).toEqual({ status: 'waiting' });
  });

  it('[edge] numeric status 1 → scanned', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 1 })), 'QP');
    expect(status).toEqual({ status: 'scanned' });
  });

  it('[edge] numeric status 2 with a bot_token → confirmed carrying the token', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 2, bot_token: 'ilbt_9f3a2c' })), 'QP');
    expect(status).toEqual({ status: 'confirmed', botToken: 'ilbt_9f3a2c' });
  });

  it('[edge] numeric status 3 → expired', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 3 })), 'QP');
    expect(status).toEqual({ status: 'expired' });
  });
});

describe('pollQrCodeStatus — string status encodings (edge)', () => {
  it('[edge] string "wait" → waiting', async () => {
    expect(await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'wait' })), 'QP')).toEqual({ status: 'waiting' });
  });

  it('[edge] string "scanned" → scanned', async () => {
    expect(await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'scanned' })), 'QP')).toEqual({ status: 'scanned' });
  });

  it('[edge] string "confirmed" with a bot_token → confirmed carrying the token', async () => {
    expect(await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'confirmed', bot_token: 'ilbt_str77' })), 'QP')).toEqual({
      status: 'confirmed',
      botToken: 'ilbt_str77',
    });
  });

  it('[edge] string "expired" → expired', async () => {
    expect(await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'expired' })), 'QP')).toEqual({ status: 'expired' });
  });
});

describe('pollQrCodeStatus — failure surfaces (adversarial)', () => {
  it('[adversarial] HTTP 500 → {status:"error"} (never throws)', async () => {
    const status = await pollQrCodeStatus(constFetch(httpFail(500)), 'QP');
    expect(status.status).toBe('error');
  });

  it('[adversarial] an app-level errcode (-1) → {status:"error"} carrying the errmsg', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ errcode: -1, errmsg: 'qrcode revoked' })), 'QP');
    expect(status).toMatchObject({ status: 'error' });
    if (status.status === 'error') expect(status.message).toContain('qrcode revoked');
  });

  it('[adversarial] a fetch that THROWS (network down) resolves to {status:"error"}, NOT a thrown error', async () => {
    // The poll runs in a UI/route path; a network throw must be caught, never propagate.
    await expect(pollQrCodeStatus(throwingFetch, 'QP')).resolves.toMatchObject({ status: 'error' });
  });

  it('[adversarial] confirmed WITHOUT a bot_token → error (a confirmed scan with no credential is unusable)', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'confirmed' })), 'QP');
    expect(status).toMatchObject({ status: 'error' });
    if (status.status === 'error') expect(status.message).toContain('bot_token');
  });

  it('[adversarial] confirmed with an EMPTY-string bot_token → error (empty credential rejected)', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 2, bot_token: '' })), 'QP');
    expect(status.status).toBe('error');
  });

  it('[adversarial] an unknown status value → error (no silent mis-decode)', async () => {
    const status = await pollQrCodeStatus(constFetch(jsonOk({ ret: 0, status: 'who-knows' })), 'QP');
    expect(status.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// fetchQrCode — throws on every failure path (it gates the whole login).
// ---------------------------------------------------------------------------
describe('fetchQrCode — failure surfaces (adversarial)', () => {
  it('[adversarial] an HTTP failure (502) throws', async () => {
    await expect(fetchQrCode(constFetch(httpFail(502)))).rejects.toThrow(/502/);
  });

  it('[adversarial] an app-level errcode throws (carries the code)', async () => {
    await expect(fetchQrCode(constFetch(jsonOk({ errcode: -3, errmsg: 'bot disabled' })))).rejects.toThrow(/-3/);
  });

  it('[adversarial] a 200 missing the qrcode payload throws', async () => {
    // Has the image but no opaque qrcode to poll with → unusable.
    await expect(
      fetchQrCode(constFetch(jsonOk({ ret: 0, qrcode_img_content: 'https://liteapp/q/z' }))),
    ).rejects.toThrow(/missing qr fields/);
  });

  it('[adversarial] a 200 missing qrcode_img_content (and qrcode_url) throws', async () => {
    await expect(fetchQrCode(constFetch(jsonOk({ ret: 0, qrcode: 'QP_only' })))).rejects.toThrow(/missing qr fields/);
  });

  it('[edge] qrcode_url is accepted as the qrUrl fallback when qrcode_img_content is absent', async () => {
    const qr = await fetchQrCode(constFetch(jsonOk({ ret: 0, qrcode: 'QP_fb', qrcode_url: 'https://liteapp/q/fb?qrcode=QP_fb' })));
    expect(qr).toEqual({ qrUrl: 'https://liteapp/q/fb?qrcode=QP_fb', qrPayload: 'QP_fb' });
  });
});

// ---------------------------------------------------------------------------
// sendText — POST body shape + failure surfaces.
// ---------------------------------------------------------------------------
describe('sendText — request body shape (edge)', () => {
  it('[edge] POSTs sendmessage with the exact reply envelope (to_user_id/context_token/message_type 2/TEXT item)', async () => {
    // Arrange — capture the outgoing request so we can assert the wire shape the
    // iLink gateway requires for a bot reply.
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return jsonOk({ ret: 0 });
    }) as FetchFn;

    // Act — a realistic bot reply to a personal-WeChat DM.
    await sendText(fetchFn, 'ilbt_live_token', 'wxuser_target', 'ctx_reply_42', '已收到，正在处理你的请求。');

    // Assert — endpoint + method.
    expect(capturedUrl).toContain('/ilink/bot/sendmessage');
    expect(capturedInit?.method).toBe('POST');

    // Assert — the body envelope.
    const body = JSON.parse(String(capturedInit?.body)) as {
      msg: {
        to_user_id: string;
        context_token: string;
        message_type: number;
        from_user_id: string;
        item_list: Array<{ type: number; text_item: { text: string } }>;
      };
      base_info: { channel_version: string };
    };
    expect(body.msg.to_user_id).toBe('wxuser_target');
    expect(body.msg.context_token).toBe('ctx_reply_42');
    expect(body.msg.message_type).toBe(2);
    expect(body.msg.item_list[0]?.type).toBe(1);
    expect(body.msg.item_list[0]?.text_item.text).toBe('已收到，正在处理你的请求。');

    // Assert — the Bearer bot_token is on the request, the body never carries it.
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer ilbt_live_token');
  });
});

describe('sendText — failure surfaces (adversarial)', () => {
  it('[adversarial] an HTTP failure (503) throws', async () => {
    await expect(
      sendText(constFetch(httpFail(503)), 'bt', 'wxuser_x', 'ctx_x', '消息'),
    ).rejects.toThrow(/503/);
  });

  it('[adversarial] an app-level errcode (-2 not friends) throws (the reply is NOT silently dropped)', async () => {
    await expect(
      sendText(constFetch(jsonOk({ errcode: -2, errmsg: 'not a friend' })), 'bt', 'wxuser_x', 'ctx_x', '消息'),
    ).rejects.toThrow(/-2/);
  });
});

// ---------------------------------------------------------------------------
// getUpdates — POST long-poll, throws on HTTP failure.
// ---------------------------------------------------------------------------
describe('getUpdates — transport failure (adversarial)', () => {
  it('[adversarial] an HTTP failure (500) throws (so the loop backs off instead of decoding garbage)', async () => {
    await expect(getUpdates(constFetch(httpFail(500)), 'bt', 'cursor-0')).rejects.toThrow(/500/);
  });

  it('[edge] a 200 batch is POSTed to getupdates and parsed into messages + an advanced cursor', async () => {
    // Arrange — assert the request method/endpoint AND that the body is parsed.
    let capturedUrl = '';
    let capturedMethod: string | undefined;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method;
      return jsonOk({
        ret: 0,
        get_updates_buf: 'cursor-advanced',
        msgs: [{ from_user_id: 'wxuser_poll', context_token: 'ctx_poll', message_id: 'mp1', item_list: [{ type: 1, text_item: { text: '长轮询到的消息' } }] }],
      });
    }) as FetchFn;

    // Act
    const result = await getUpdates(fetchFn, 'ilbt_poll', 'cursor-0');

    // Assert
    expect(capturedUrl).toContain('/ilink/bot/getupdates');
    expect(capturedMethod).toBe('POST');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ chatId: 'wxuser_poll', text: '长轮询到的消息' });
    expect(result.newCursor).toBe('cursor-advanced');
    expect(result.sessionExpired).toBe(false);
  });
});
