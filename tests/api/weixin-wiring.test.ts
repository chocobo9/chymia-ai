// tests/api/weixin-wiring.test.ts — M14b personal-WeChat (iLink) dev happy-path.
//
// Covers the iLink protocol client + the full operability chain: QR login confirm
// → the long-poll adapter starts → an inbound text is routed through the pipeline
// → the agent reply is sent back via sendmessage. A FAKE fetch makes the whole
// thing deterministic + offline; a temp token store keeps it off ~/.choco. Edge
// (bad status, session-expiry, logout) are the QA instance's.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { WeixinTokenStore } from '@choco/api/config/weixin-token-store';
import { parseUpdates, pollQrCodeStatus, fetchQrCode } from '@choco/adapters/weixin';
import { replyScript, CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20));
  if (!cond()) throw new Error('waitFor timed out');
}

describe('iLink client (dev happy path)', () => {
  it('parseUpdates extracts a text message, advances the cursor, flags session expiry', () => {
    const raw = {
      ret: 0,
      get_updates_buf: 'cursor-2',
      msgs: [
        {
          from_user_id: 'wxuser_abc',
          context_token: 'ctx-77',
          message_id: 9001,
          item_list: [{ type: 1, text_item: { text: '在吗' } }],
        },
        { from_user_id: 'u2', context_token: 'c2', item_list: [{ type: 2 }] }, // non-text → skipped
      ],
    };
    const r = parseUpdates(raw, 'cursor-1');
    expect(r.sessionExpired).toBe(false);
    expect(r.newCursor).toBe('cursor-2');
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ chatId: 'wxuser_abc', text: '在吗', contextToken: 'ctx-77' });

    expect(parseUpdates({ errcode: -14 }, 'c').sessionExpired).toBe(true);
  });

  it('fetchQrCode + pollQrCodeStatus parse the iLink responses', async () => {
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('get_bot_qrcode')) {
        return jsonResponse({ qrcode: 'QP1', qrcode_img_content: 'https://liteapp/q/x?qrcode=QP1', ret: 0 });
      }
      return jsonResponse({ status: 'confirmed', bot_token: 'BOT_TOKEN_1', ret: 0 });
    }) as typeof globalThis.fetch;

    const qr = await fetchQrCode(fetchFn);
    expect(qr).toEqual({ qrUrl: 'https://liteapp/q/x?qrcode=QP1', qrPayload: 'QP1' });
    expect(await pollQrCodeStatus(fetchFn, 'QP1')).toEqual({ status: 'confirmed', botToken: 'BOT_TOKEN_1' });
  });
});

describe('personal-WeChat OPERABILITY: login → poll inbound → reply (dev happy path)', () => {
  let dir: string;
  let tokenStore: WeixinTokenStore;
  const sends: Array<{ to_user_id: string; context_token: string; text: string }> = [];
  let app: BuiltApp;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-weixin-'));
    tokenStore = new WeixinTokenStore(join(dir, 'weixin-bot.json'));
    sends.length = 0;
  });
  afterEach(async () => {
    await app.weixinManager.logout(); // stop the poll loop
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeFetch(): typeof globalThis.fetch {
    let getUpdatesCalls = 0;
    return (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('get_bot_qrcode')) {
        return jsonResponse({ qrcode: 'QP', qrcode_img_content: 'https://liteapp/q/y?qrcode=QP', ret: 0 });
      }
      if (url.includes('get_qrcode_status')) {
        return jsonResponse({ status: 'confirmed', bot_token: 'BT', ret: 0 });
      }
      if (url.includes('getupdates')) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: 'c1',
            msgs: [
              {
                from_user_id: 'wxuser_1',
                context_token: 'ctx_1',
                message_id: 'm1',
                item_list: [{ type: 1, text_item: { text: '@claude-opus 帮我看看' } }],
              },
            ],
          });
        }
        await new Promise((r) => setTimeout(r, 40)); // subsequent long-poll: brief empty
        return jsonResponse({ ret: 0, get_updates_buf: 'c1', msgs: [] });
      }
      if (url.includes('sendmessage')) {
        const body = JSON.parse(String(init?.body)) as {
          msg: { to_user_id: string; context_token: string; item_list: Array<{ text_item: { text: string } }> };
        };
        sends.push({
          to_user_id: body.msg.to_user_id,
          context_token: body.msg.context_token,
          text: body.msg.item_list[0]!.text_item.text,
        });
        return jsonResponse({ ret: 0 });
      }
      return jsonResponse({ ret: 0 });
    }) as typeof globalThis.fetch;
  }

  it('a confirmed QR connects, and an inbound message is routed and replied to the same chat', async () => {
    const db = new Database(':memory:');
    app = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到，马上看。')]) },
      weixinFetchFn: makeFetch(),
      weixinTokenStore: tokenStore,
    });

    // Login flow via the real routes.
    const start = await app.api.inject({ method: 'POST', url: '/api/adapters/weixin/login/start' });
    expect(start.json().qrPayload).toBe('QP');

    const status = await app.api.inject({
      method: 'GET',
      url: '/api/adapters/weixin/login/status?qrPayload=QP',
    });
    expect(status.json().status).toBe('confirmed');

    // Now connected; the bot_token was persisted.
    expect(app.api.inject).toBeDefined();
    expect(tokenStore.get()).toBe('BT');
    const conn = await app.api.inject({ method: 'GET', url: '/api/adapters/weixin/status' });
    expect(conn.json()).toMatchObject({ connected: true, hasToken: true });

    // The long-poll picked up the inbound message, routed it, and replied to the chat.
    await waitFor(() => sends.length > 0);
    expect(sends[0]).toEqual({ to_user_id: 'wxuser_1', context_token: 'ctx_1', text: '已收到，马上看。' });
  });
});
