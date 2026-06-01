// G3 platform-ingress dev happy-path suite. QA owns edge + adversarial coverage.
//
// Exercises the submitPlatformMessage seam end-to-end over an in-memory db + a
// Fake provider: an inbound platform message resolves A10 ids, drives the SAME
// pipeline as the HTTP route, and returns the agent replies for the adapter to
// send back. Real platform-shaped ids + a real @mention so the route is taken.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage, StoredMessage, IncomingPlatformMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { replyScript, CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(scripts: Record<string, readonly (readonly AgentMessage[])[]>): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db, agentServices: fakes });
}

const WECHAT_CHANNEL = 'gh_a1b2c3d4e5f6';
const WECHAT_OPENID = 'oABCdEf1234567890ghijklmnop';

function incoming(text: string): IncomingPlatformMessage {
  return {
    adapterName: 'wechat',
    channelId: WECHAT_CHANNEL,
    platformUserId: WECHAT_OPENID,
    platformMessageId: 'msg_1024',
    text,
    receivedAt: 1_700_000_000_000,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('submitPlatformMessage (happy path)', () => {
  it('resolves A10 ids, routes, and returns the collected agent replies', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '已收到，正在评估数据库选型。')],
    });
    cleanups.push(app.close);

    const result = await app.submitPlatformMessage(
      incoming('@claude-opus 帮我评估一下 Postgres 还是 SQLite'),
    );

    expect(result.threadId).toMatch(/^thread_wechat_/);
    expect(result.userId).toMatch(/^user_wechat_/);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]?.agentId).toBe(CLAUDE);
    expect(result.replies[0]?.content).toBe('已收到，正在评估数据库选型。');
  });

  it('persists the user message + reply on the resolved thread', async () => {
    const app = injectApp({
      'claude-opus': [replyScript(CLAUDE, '建议先看读写比例。')],
    });
    cleanups.push(app.close);

    const result = await app.submitPlatformMessage(incoming('@claude-opus 选型建议？'));

    const history: StoredMessage[] = await app.stores.messageStore.getByThread(
      result.threadId,
    );
    expect(history).toHaveLength(2); // user message + one agent reply
    const userMsg = history.find((m) => m.origin === 'user');
    const replyMsg = history.find((m) => m.origin === 'stream');
    expect(userMsg?.content).toBe('@claude-opus 选型建议？');
    expect(replyMsg?.agentId).toBe(CLAUDE);
  });

  it('routes a second message from the same platform channel to the same thread', async () => {
    const app = injectApp({
      'claude-opus': [
        replyScript(CLAUDE, '第一轮回复。'),
        replyScript(CLAUDE, '第二轮回复。'),
      ],
    });
    cleanups.push(app.close);

    const first = await app.submitPlatformMessage(incoming('@claude-opus 第一问'));
    const second = await app.submitPlatformMessage(incoming('@claude-opus 第二问'));

    expect(second.threadId).toBe(first.threadId);
    expect(second.userId).toBe(first.userId);

    const history = await app.stores.messageStore.getByThread(first.threadId);
    expect(history).toHaveLength(4); // 2 user + 2 replies on one thread
  });

  it('reverse-resolves the resolved thread back to the platform channel', async () => {
    const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, 'ok')] });
    cleanups.push(app.close);

    const result = await app.submitPlatformMessage(incoming('@claude-opus hi'));

    const channel = await app.platformMappingStore.getChannelId('wechat', result.threadId);
    expect(channel).toBe(WECHAT_CHANNEL);
  });
});
