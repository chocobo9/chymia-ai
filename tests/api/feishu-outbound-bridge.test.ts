// tests/api/feishu-outbound-bridge.test.ts — Issue B: web→飞书 双向桥.
//
// A thread linked to a 飞书 channel (via a 飞书 inbound) must mirror a turn that
// originates OFF-platform (web/HTTP) BACK to that 飞书 channel — user message +
// agent replies. The reverse must NOT happen for a 飞书-originated turn (echo
// prevention: its own adapter already delivered it inbound). Before this wiring the
// bridge was one-way (飞书→web only), so the web-typed message never reached 飞书
// (user 2026-06-05).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FeishuConfigStore } from '@choco/api/config/feishu-config-store';
import { CLAUDE, replyScript } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A fake feishu adapter that records out-of-band sendToChannel pushes. */
function makeRecordingFeishu(): {
  factory: () => { start: () => Promise<void>; stop: () => Promise<void>; isConnected: boolean; sendToChannel: (channelId: string, text: string) => Promise<void> };
  sent: Array<{ channelId: string; text: string }>;
} {
  const sent: Array<{ channelId: string; text: string }> = [];
  const factory = () => ({
    start: async () => {},
    stop: async () => {},
    isConnected: true,
    sendToChannel: async (channelId: string, text: string) => {
      sent.push({ channelId, text });
    },
  });
  return { factory, sent };
}

async function connectedApp(): Promise<{ app: BuiltApp; sent: Array<{ channelId: string; text: string }> }> {
  const dir = mkdtempSync(join(tmpdir(), 'choco-feishu-out-'));
  const store = new FeishuConfigStore(join(dir, 'feishu.json'));
  const { factory, sent } = makeRecordingFeishu();
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    agentServices: {
      'claude-opus': new FakeAgentService([replyScript(CLAUDE, '飞书侧回复'), replyScript(CLAUDE, '网页侧回复')]),
    },
    feishuStore: store,
    feishuAdapterFactory: factory,
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(async () => {
    await app.close();
  });
  // Connect the (fake) feishu long-connection so the manager holds a live adapter.
  await app.api.inject({
    method: 'PUT',
    url: '/api/adapters/feishu/config',
    payload: { appId: 'cli_x', appSecret: 'sec_x', enabled: true },
  });
  return { app, sent };
}

describe('web→飞书 outbound bridge (Issue B)', () => {
  it('[happy] a web turn in a 飞书-linked thread is mirrored to the 飞书 channel; a 飞书-origin turn is NOT (echo prevention)', async () => {
    const { app, sent } = await connectedApp();

    // 飞书 inbound establishes the channel↔thread link AND is the origin → must NOT
    // be pushed back to 飞书 by the bridge (the adapter already delivers it inbound).
    const inbound = await app.submitPlatformMessage({
      adapterName: 'feishu',
      channelId: 'oc_bridge_1',
      platformUserId: 'ou_user',
      platformMessageId: 'om_1',
      text: '@claude-opus 飞书发起',
      receivedAt: 1_700_000_000_000,
    });
    expect(sent).toEqual([]); // echo prevention: feishu-origin turn not re-pushed to feishu

    // A web/HTTP turn in the SAME thread → mirrored OUT to the linked 飞书 channel.
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${inbound.threadId}/messages`,
      payload: { content: '@claude-opus 网页发起' },
    });
    expect(res.statusCode).toBe(200);

    // Pushed to the right channel, carrying BOTH the user message and the agent reply.
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.every((s) => s.channelId === 'oc_bridge_1')).toBe(true);
    expect(sent.some((s) => s.text.includes('网页发起'))).toBe(true); // user message mirrored
    expect(sent.some((s) => s.text.includes('网页侧回复'))).toBe(true); // agent reply mirrored
  });

  it('[edge] a web turn in a NON-linked (web-only) thread pushes nothing to 飞书', async () => {
    const { app, sent } = await connectedApp();
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread_web_only/messages',
      payload: { content: '@claude-opus 只在网页' },
    });
    expect(res.statusCode).toBe(200);
    expect(sent).toEqual([]); // no feishu mapping for this thread → no outbound
  });
});
