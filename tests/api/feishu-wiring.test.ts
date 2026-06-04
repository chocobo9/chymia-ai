// tests/api/feishu-wiring.test.ts — M-FEISHU 飞书 dev happy-path.
//
// Covers the Feishu HTTP surface (token / send / event parse), the OPERABILITY
// chain (an im.message.receive_v1 event → ingress pipeline → reply via the Feishu
// API), and the config-route flow (a fake adapter factory drives connect/disconnect
// WITHOUT a real WebSocket). Edge (zod-400, secret-mask, group/non-text) → QA.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FeishuConfigStore } from '@choco/api/config/feishu-config-store';
import {
  FeishuAdapter,
  parseFeishuEvent,
  FeishuTokenCache,
  sendFeishuText,
} from '@choco/adapters/feishu';
import { replyScript, CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function p2pTextEvent(text: string): unknown {
  return {
    header: { event_type: 'im.message.receive_v1' },
    event: {
      message: {
        chat_type: 'p2p',
        message_type: 'text',
        chat_id: 'oc_chat_1',
        message_id: 'om_msg_1',
        content: JSON.stringify({ text }),
      },
      sender: { sender_id: { open_id: 'ou_user_1' } },
    },
  };
}

describe('Feishu HTTP surface (dev happy path)', () => {
  it('parseFeishuEvent extracts a p2p text message; ignores group / non-text', () => {
    const ok = parseFeishuEvent(p2pTextEvent('你好飞书'));
    expect(ok).toEqual({ chatId: 'oc_chat_1', text: '你好飞书', messageId: 'om_msg_1', senderId: 'ou_user_1' });

    const group = parseFeishuEvent({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { chat_type: 'group', message_type: 'text', chat_id: 'g', message_id: 'm', content: '{"text":"x"}' } },
    });
    expect(group).toBeNull();
    expect(parseFeishuEvent({ header: { event_type: 'other' } })).toBeNull();
  });

  it('FeishuTokenCache + sendFeishuText hit the right endpoints with the right body', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 'TT', expire: 7200 });
      }
      return jsonResponse({ code: 0 });
    }) as typeof globalThis.fetch;

    const cache = new FeishuTokenCache('cli_app', 'sec', fetchFn);
    expect(await cache.get()).toBe('TT');
    await sendFeishuText(fetchFn, 'TT', 'oc_chat_1', '回复内容');

    const send = calls.find((c) => c.url.includes('im/v1/messages'));
    expect(send?.body).toMatchObject({ receive_id: 'oc_chat_1', msg_type: 'text', content: JSON.stringify({ text: '回复内容' }) });
  });
});

describe('Feishu OPERABILITY: event → pipeline → reply (dev happy path)', () => {
  it('an inbound p2p text is routed and the agent reply is sent back to the chat', async () => {
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到，飞书。')]) },
    });

    const sends: Array<{ receive_id: string; text: string }> = [];
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('tenant_access_token')) {
        return jsonResponse({ code: 0, tenant_access_token: 'TT', expire: 7200 });
      }
      if (url.includes('im/v1/messages')) {
        const body = JSON.parse(String(init?.body)) as { receive_id: string; content: string };
        sends.push({ receive_id: body.receive_id, text: (JSON.parse(body.content) as { text: string }).text });
        return jsonResponse({ code: 0 });
      }
      return jsonResponse({ code: 0 });
    }) as typeof globalThis.fetch;

    // Drive the testable inbound core directly (no live WebSocket).
    const adapter = new FeishuAdapter({
      submitPlatformMessage: app.submitPlatformMessage,
      appId: 'cli_app',
      appSecret: 'sec',
      fetchFn,
    });
    await adapter.handleEvent(p2pTextEvent('@claude-opus 看下这个'));

    expect(sends).toEqual([{ receive_id: 'oc_chat_1', text: '已收到，飞书。' }]);
    await app.close();
  });
});

describe('Feishu config routes (dev happy path)', () => {
  let dir: string;
  let store: FeishuConfigStore;
  const factoryCalls: { starts: number; stops: number } = { starts: 0, stops: 0 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-feishu-'));
    store = new FeishuConfigStore(join(dir, 'feishu.json'));
    factoryCalls.starts = 0;
    factoryCalls.stops = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function injectApp(): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      feishuStore: store,
      feishuAdapterFactory: () => ({
        start: async () => {
          factoryCalls.starts += 1;
        },
        stop: async () => {
          factoryCalls.stops += 1;
        },
        isConnected: true,
      }),
    });
  }

  it('GET masked; PUT enabled+complete connects; PUT disable disconnects; secret never leaks', async () => {
    const app = injectApp();

    const before = await app.api.inject({ method: 'GET', url: '/api/adapters/feishu/config' });
    expect(before.json().config).toMatchObject({ enabled: false, hasAppSecret: false, ready: false });

    const on = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { appId: 'cli_x', appSecret: 'sec_x', enabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().config).toMatchObject({ appId: 'cli_x', hasAppSecret: true, ready: true });
    expect(on.json().status.connected).toBe(true);
    expect(on.body).not.toContain('sec_x'); // secret never crosses the boundary
    expect(factoryCalls.starts).toBe(1);

    const off = await app.api.inject({
      method: 'PUT',
      url: '/api/adapters/feishu/config',
      payload: { enabled: false },
    });
    expect(off.json().status.connected).toBe(false);

    await app.close();
  });
});
