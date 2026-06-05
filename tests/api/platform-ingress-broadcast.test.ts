// G3 — platform ingress mirrors the inbound USER message to live web clients.
//
// A 飞书/Telegram/微信 user is off-web: no browser client renders their message,
// so submitPlatformMessage broadcasts it as `thread_message` to the thread room.
// This is a REAL socket.io client against a listening buildApp (the designed
// seam) — the same idiom as socket.edge.test.ts — so it proves the end-to-end
// path the web's useSocket handler consumes, not just that a method was called.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { StoredMessage, IncomingPlatformMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, connectClient, replyScript } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function listen(): Promise<{ app: BuiltApp; baseUrl: string }> {
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '收到')]) },
  });
  cleanups.push(async () => {
    await app.close();
  });
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';
  return { app, baseUrl };
}

function feishuIncoming(text: string): IncomingPlatformMessage {
  return {
    adapterName: 'feishu',
    channelId: 'oc_chat_web_sync_1',
    platformUserId: 'ou_user_web_sync_1',
    platformMessageId: `om_${text}`,
    text,
    receivedAt: 1_700_000_000_000,
  };
}

describe('platform ingress → live web mirror (thread_message)', () => {
  it('a 飞书 inbound user message is broadcast as thread_message to the joined room', async () => {
    const { app, baseUrl } = await listen();

    // The first inbound creates the thread; capture its id so the client can join.
    const first = await app.submitPlatformMessage(feishuIncoming('第一条建立会话'));
    const socket = await connectClient(baseUrl, first.threadId);
    cleanups.push(() => {
      socket.disconnect();
    });

    const received = new Promise<StoredMessage>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no thread_message within 3s')), 3000);
      socket.on('thread_message', (m: StoredMessage) => {
        clearTimeout(timer);
        resolve(m);
      });
    });

    await app.submitPlatformMessage(feishuIncoming('第二条要同步到 web 端'));
    const mirrored = await received;

    expect(mirrored.content).toBe('第二条要同步到 web 端');
    expect(mirrored.origin).toBe('user');
    expect(mirrored.threadId).toBe(first.threadId);
    expect(mirrored.agentId).toBeNull();
  });
});
