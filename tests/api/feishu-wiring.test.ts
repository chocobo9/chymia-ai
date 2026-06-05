// tests/api/feishu-wiring.test.ts — M-FEISHU 飞书 dev happy-path (LarkChannel).
//
// Covers the OPERABILITY chain on the new high-level LarkChannel adapter: a
// normalized inbound p2p text → the REAL ingress pipeline (buildApp →
// submitPlatformMessage → handleThreadMessage) → the agent reply STREAMS into a
// 飞书 card via channel.stream (Phase 2; the streamed card is the authoritative
// reply, not also re-sent). Plus the config-route flow (a fake adapter factory
// drives connect/disconnect WITHOUT a real WebSocket).
//
// Edge/adversarial (group @-reply opts, non-text placeholder, throwing send,
// zod-400, secret-mask, onTextDelta backward-compat) → independent QA (dev≠QA §0.5.3).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { NormalizedMessage, SendInput, SendOptions } from '@larksuiteoapi/node-sdk';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FeishuConfigStore } from '@choco/api/config/feishu-config-store';
import { createFeishuAdapter, type LarkChannelLike } from '@choco/adapters/feishu';
import { replyScript, CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** A normalized p2p text message (what LarkChannel hands the 'message' handler). */
function p2pTextMessage(text: string): NormalizedMessage {
  return {
    messageId: 'om_msg_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    senderId: 'ou_user_1',
    content: text,
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1_700_000_000_000,
  };
}

/** A fake LarkChannel: captures sends + reactions and DRIVES the markdown stream producer. */
function makeFakeChannel(): {
  channel: LarkChannelLike;
  sends: Array<{ to: string; input: SendInput; opts: SendOptions | undefined }>;
  streamedCards: string[];
  reactedMessageIds: string[];
} {
  const sends: Array<{ to: string; input: SendInput; opts: SendOptions | undefined }> = [];
  const streamedCards: string[] = [];
  const reactedMessageIds: string[] = [];
  const channel: LarkChannelLike = {
    connect: async () => {},
    disconnect: async () => {},
    on: (() => () => {}) as LarkChannelLike['on'],
    send: async (to, input, opts) => {
      sends.push({ to, input, opts });
      return { messageId: 'om_send' };
    },
    stream: async (_to, input) => {
      if ('markdown' in input) {
        let acc = '';
        await input.markdown({
          messageId: 'om_stream',
          setContent: async (full: string) => {
            acc = full;
          },
          append: async (chunk: string) => {
            acc += chunk;
          },
        });
        streamedCards.push(acc);
      }
      return { messageId: 'om_stream' };
    },
    addReaction: async (messageId: string) => {
      reactedMessageIds.push(messageId);
      return 'reaction_1';
    },
    getConnectionStatus: () => ({ state: 'connected' }),
  };
  return { channel, sends, streamedCards, reactedMessageIds };
}

describe('Feishu OPERABILITY: inbound → pipeline → streaming card (dev happy path)', () => {
  it('a p2p text routes through the REAL ingress pipeline and the agent reply streams into a 飞书 card', async () => {
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到，飞书。')]) },
    });
    const { channel, sends, streamedCards, reactedMessageIds } = makeFakeChannel();

    const adapter = createFeishuAdapter({
      submitPlatformMessage: app.submitPlatformMessage,
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => channel,
    });
    await adapter.start();
    await adapter.handleMessage(p2pTextMessage('@claude-opus 看下这个'));

    // L1: instant ❤️ receipt reaction on the user's inbound message.
    expect(reactedMessageIds).toEqual(['om_msg_1']);
    // The agent reply is delivered AS the streaming card (authoritative): the
    // card's accumulated content carries the agent text, and it is NOT also
    // re-sent as a separate markdown message.
    expect(streamedCards.length).toBe(1);
    expect(streamedCards[0]).toContain('已收到，飞书。');
    expect(sends).toEqual([]);

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
