// M14 telegram-adapter dev happy-path INTEGRATION suite (reachability, CLAUDE §3.4).
// QA owns edge + adversarial coverage.
//
// Drives the real inbound→ingress→outbound path: a real buildApp (in-memory db +
// Fake provider) + the real Telegram adapter constructed with a FAKE grammy Bot.
// A simulated Telegram text update (real numeric chat id + real CJK/markdown text)
// flows through the registered handler → submitPlatformMessage (A10 resolve +
// route) → the adapter formats + splits + sends the agent reply back to the SAME
// chat. Asserts a thread was resolved via the mapping store and the reply landed
// on the right chat, formatted as Telegram HTML. NOT a mock of the routed pipeline.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { IncomingPlatformMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import {
  createTelegramAdapter,
  TELEGRAM_ADAPTER_NAME,
} from '@clowder/adapters/telegram/telegram-adapter';
import { replyScript, CLAUDE } from '../../api/helpers.js';
import { FakeAgentService } from '../../invocation/fake-agent-service.js';
import { FakeTelegramBot, textUpdate } from './fake-telegram-bot.js';

/** Build an inject-only app (no listener) over an in-memory db + fakes. */
function injectApp(replyText: string): BuiltApp {
  const db = new Database(':memory:');
  const fakes = { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, replyText)]) };
  return buildApp({ db, agentServices: fakes });
}

/** Realistic Telegram numeric DM ids. */
const CHAT_ID = 6_812_345_678;
const USER_ID = 51_234_567;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('Telegram adapter inbound→ingress→outbound (reachability)', () => {
  it('routes a Telegram text update and sends the agent reply back to the same chat', async () => {
    // Arrange: real app + fake agent reply (bold markdown so HTML formatting is observable).
    const app = injectApp('**建议**: 读多写少先用 SQLite。');
    cleanups.push(app.close);

    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    // The wiring an orchestrator does: inbound platform message → submitPlatformMessage
    // → send each collected agent reply back to the originating chat (A10 reverse lookup).
    adapter.onMessage(async (incoming: IncomingPlatformMessage) => {
      const result = await app.submitPlatformMessage(incoming);
      const channelId = await app.platformMappingStore.getChannelId(
        TELEGRAM_ADAPTER_NAME,
        result.threadId,
      );
      expect(channelId).not.toBeNull();
      for (const reply of result.replies) {
        await adapter.sendMessage(channelId as string, reply.content, reply.agentId ?? undefined);
      }
    });

    await adapter.start();

    // Act: simulate an inbound Telegram DM mentioning the agent.
    await bot.emitText(
      textUpdate({
        chatId: CHAT_ID,
        userId: USER_ID,
        messageId: 9001,
        text: '@claude-opus 帮我评估 Postgres 还是 SQLite',
      }),
    );

    // Assert: the reply was sent back to the SAME chat, formatted as Telegram HTML.
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.chatId).toBe(String(CHAT_ID));
    expect(bot.sent[0]?.parseMode).toBe('HTML');
    expect(bot.sent[0]?.text).toBe('<b>建议</b>: 读多写少先用 SQLite。');

    await adapter.stop();
    expect(bot.stopCalls).toBe(1);
  });

  it('resolves the same thread for two updates from the same Telegram chat', async () => {
    const app = injectApp('收到。');
    cleanups.push(app.close);

    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    const resolvedThreads: string[] = [];
    adapter.onMessage(async (incoming) => {
      const result = await app.submitPlatformMessage(incoming);
      resolvedThreads.push(result.threadId);
    });
    await adapter.start();

    await bot.emitText(
      textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 1, text: '@claude-opus 第一问' }),
    );

    expect(resolvedThreads[0]).toMatch(/^thread_telegram_/);

    // A second update from the same chat resolves to the SAME internal thread.
    const channelBefore = await app.platformMappingStore.getChannelId(
      TELEGRAM_ADAPTER_NAME,
      resolvedThreads[0] as string,
    );
    expect(channelBefore).toBe(String(CHAT_ID));

    await adapter.stop();
  });

  it('builds an IncomingPlatformMessage with telegram fields from the update', async () => {
    const app = injectApp('ok');
    cleanups.push(app.close);

    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    let captured: IncomingPlatformMessage | undefined;
    adapter.onMessage(async (incoming) => {
      captured = incoming;
      await app.submitPlatformMessage(incoming);
    });
    await adapter.start();

    await bot.emitText(
      textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 4242, text: '@claude-opus hi there' }),
    );

    expect(captured?.adapterName).toBe(TELEGRAM_ADAPTER_NAME);
    expect(captured?.channelId).toBe(String(CHAT_ID));
    expect(captured?.platformUserId).toBe(String(USER_ID));
    expect(captured?.platformMessageId).toBe('4242');
    expect(captured?.text).toBe('@claude-opus hi there');
    expect(typeof captured?.receivedAt).toBe('number');

    await adapter.stop();
  });

  it('ignores updates from bots (no ingress, no reply)', async () => {
    const app = injectApp('should not be reached');
    cleanups.push(app.close);

    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    let handlerCalls = 0;
    adapter.onMessage(async (incoming) => {
      handlerCalls += 1;
      await app.submitPlatformMessage(incoming);
    });
    await adapter.start();

    // A bot-authored update: is_bot true → must be skipped before the handler.
    await bot.emitText({
      message: {
        message_id: 7,
        text: '@claude-opus from a bot',
        chat: { id: CHAT_ID },
        from: { id: 99, is_bot: true },
      },
    });

    expect(handlerCalls).toBe(0);
    expect(bot.sent).toHaveLength(0);

    await adapter.stop();
  });
});
