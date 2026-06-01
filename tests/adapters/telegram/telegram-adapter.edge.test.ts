// M14 telegram-adapter QA edge + adversarial suite (authored by QA, not the dev).
//
// FOCUS (adapter behavior, no full app — FakeTelegramBot only):
//  - inbound normalization: a normal user text update → IncomingPlatformMessage with
//    the correct STRINGified numeric chat/user/message ids;
//  - SKIP semantics: bot-authored, sender-less, and non-text updates never reach the
//    registered handler;
//  - error isolation: a handler that throws is logged, NOT rethrown (long-poll loop
//    must not crash);
//  - lifecycle: start() does not hang awaiting grammy long-poll; double start/stop is
//    idempotent; a handler firing before start() is registered is a no-op (skip path);
//  - outbound: sendMessage formats to HTML, splits >4096 into ordered chunks, and
//    sends each to the right chat id with parse_mode HTML.
//
// Realistic numeric Telegram ids + real markdown/CJK/emoji — no placeholders.

import { describe, it, expect, vi } from 'vitest';
import type { IncomingPlatformMessage } from '@clowder/shared';
import {
  createTelegramAdapter,
  TELEGRAM_ADAPTER_NAME,
  type TelegramLogger,
  type TelegramUpdateContext,
} from '@clowder/adapters/telegram/telegram-adapter';
import { TELEGRAM_MAX_MESSAGE_LENGTH as LIMIT } from '@clowder/adapters/telegram/message-splitter';
import { FakeTelegramBot, textUpdate } from './fake-telegram-bot.js';

const CHAT_ID = 6_812_345_678;
const USER_ID = 51_234_567;

/** Collect log events into an array so we can assert on error isolation. */
function recordingLogger(): { log: TelegramLogger; events: Array<{ level: string; message: string }> } {
  const events: Array<{ level: string; message: string }> = [];
  const log: TelegramLogger = (e) => {
    events.push({ level: e.level, message: e.message });
  };
  return { log, events };
}

describe('telegram-adapter inbound SKIP semantics (adversarial)', () => {
  it('[adv] skips a bot-authored update (is_bot true) — handler never invoked', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let calls = 0;
    adapter.onMessage(async () => {
      calls += 1;
    });
    await adapter.start();

    await bot.emitText({
      message: {
        message_id: 7,
        text: '@claude-opus 我是另一个 bot',
        chat: { id: CHAT_ID },
        from: { id: 99_000_111, is_bot: true },
      },
    });

    expect(calls).toBe(0);
    expect(bot.sent).toHaveLength(0);
  });

  it('[adv] skips an update with no sender (from undefined)', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let calls = 0;
    adapter.onMessage(async () => {
      calls += 1;
    });
    await adapter.start();

    await bot.emitText({
      message: { message_id: 8, text: '系统频道广播', chat: { id: CHAT_ID } },
    });

    expect(calls).toBe(0);
  });

  it('[adv] skips a non-text update (text undefined — e.g. a sticker/photo)', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let calls = 0;
    adapter.onMessage(async () => {
      calls += 1;
    });
    await adapter.start();

    await bot.emitText({
      message: {
        message_id: 9,
        chat: { id: CHAT_ID },
        from: { id: USER_ID, is_bot: false },
      },
    } as TelegramUpdateContext);

    expect(calls).toBe(0);
  });

  it('[edge] skips an update with no message at all (e.g. edited_message-only update)', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let calls = 0;
    adapter.onMessage(async () => {
      calls += 1;
    });
    await adapter.start();

    await bot.emitText({ update: { update_id: 5 } } as TelegramUpdateContext);

    expect(calls).toBe(0);
  });
});

describe('telegram-adapter inbound normalization (edge)', () => {
  it('[edge] normalizes numeric ids to strings and carries raw update through', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let captured: IncomingPlatformMessage | undefined;
    adapter.onMessage(async (m) => {
      captured = m;
    });
    await adapter.start();

    await bot.emitText(
      textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 4242, text: '@claude-opus 评估 Postgres' }),
    );

    expect(captured?.adapterName).toBe(TELEGRAM_ADAPTER_NAME);
    expect(captured?.channelId).toBe(String(CHAT_ID));
    expect(captured?.platformUserId).toBe(String(USER_ID));
    expect(captured?.platformMessageId).toBe('4242');
    expect(captured?.text).toBe('@claude-opus 评估 Postgres');
    expect(typeof captured?.receivedAt).toBe('number');
    expect(captured?.raw).toBeDefined();
  });

  it('[edge] preserves an empty-string text (present but empty) — not treated as missing', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    let captured: IncomingPlatformMessage | undefined;
    adapter.onMessage(async (m) => {
      captured = m;
    });
    await adapter.start();

    await bot.emitText({
      message: {
        message_id: 10,
        text: '',
        chat: { id: CHAT_ID },
        from: { id: USER_ID, is_bot: false },
      },
    });

    // text is a string (''), so toIncoming must NOT skip it.
    expect(captured).toBeDefined();
    expect(captured?.text).toBe('');
  });
});

describe('telegram-adapter error isolation (adversarial)', () => {
  it('[adv] a throwing handler is logged at error level and NOT rethrown', async () => {
    const bot = new FakeTelegramBot();
    const { log, events } = recordingLogger();
    const adapter = createTelegramAdapter({ bot, logger: log });
    adapter.onMessage(async () => {
      throw new Error('submitPlatformMessage exploded (routing store offline)');
    });
    await adapter.start();

    // Must resolve, not reject — the long-poll loop must survive a handler failure.
    await expect(
      bot.emitText(textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 1, text: '@claude-opus 触发错误' })),
    ).resolves.toBeUndefined();

    const errs = events.filter((e) => e.level === 'error');
    expect(errs.length).toBe(1);
    expect(errs[0]?.message).toContain('inbound handler failed');
    expect(errs[0]?.message).toContain('submitPlatformMessage exploded');
  });

  it('[adv] a handler rejecting with a non-Error value is still isolated and logged', async () => {
    const bot = new FakeTelegramBot();
    const { log, events } = recordingLogger();
    const adapter = createTelegramAdapter({ bot, logger: log });
    adapter.onMessage(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string-shaped failure';
    });
    await adapter.start();

    await expect(
      bot.emitText(textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 2, text: '@claude-opus 再次触发' })),
    ).resolves.toBeUndefined();

    expect(events.some((e) => e.level === 'error' && e.message.includes('string-shaped failure'))).toBe(true);
  });

  it('[edge] an inbound update before onMessage is registered is a logged no-op (no throw)', async () => {
    const bot = new FakeTelegramBot();
    const { log, events } = recordingLogger();
    const adapter = createTelegramAdapter({ bot, logger: log });
    // Note: NOT calling onMessage. start() registers dispatch on the bot.
    await adapter.start();

    await expect(
      bot.emitText(textUpdate({ chatId: CHAT_ID, userId: USER_ID, messageId: 3, text: '@claude-opus 早到的消息' })),
    ).resolves.toBeUndefined();

    expect(events.some((e) => e.level === 'warn' && e.message.includes('before onMessage'))).toBe(true);
  });
});

describe('telegram-adapter lifecycle (edge)', () => {
  it('[edge] start() resolves promptly and does NOT await grammy long-poll', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    // FakeTelegramBot.start() returns a promise that never resolves until stop().
    // If the adapter awaited it, this would hang past the test timeout.
    await adapter.start();
    expect(bot.startCalls).toBe(1);

    await adapter.stop();
    expect(bot.stopCalls).toBe(1);
  });

  it('[edge] double start() is idempotent — bot.start called once', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    await adapter.start();
    await adapter.start();
    expect(bot.startCalls).toBe(1);
    await adapter.stop();
  });

  it('[edge] stop() before start() is a no-op (does not call bot.stop)', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });
    await adapter.stop();
    expect(bot.stopCalls).toBe(0);
  });

  it('[edge] passes drop_pending_updates=true by default to bot.start', async () => {
    const bot = new FakeTelegramBot();
    const startSpy = vi.spyOn(bot, 'start');
    const adapter = createTelegramAdapter({ bot });
    await adapter.start();
    expect(startSpy).toHaveBeenCalledWith({ drop_pending_updates: true });
    await adapter.stop();
  });

  it('[edge] respects dropPendingUpdates=false override', async () => {
    const bot = new FakeTelegramBot();
    const startSpy = vi.spyOn(bot, 'start');
    const adapter = createTelegramAdapter({ bot, dropPendingUpdates: false });
    await adapter.start();
    expect(startSpy).toHaveBeenCalledWith({ drop_pending_updates: false });
    await adapter.stop();
  });
});

describe('telegram-adapter outbound formatting + splitting + routing (adversarial)', () => {
  it('[adv] sendMessage formats markdown to HTML and routes to the exact chat id with parse_mode HTML', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    await adapter.sendMessage(String(CHAT_ID), '**建议**: 读多写少先用 `SQLite`。');

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.chatId).toBe(String(CHAT_ID));
    expect(bot.sent[0]?.parseMode).toBe('HTML');
    expect(bot.sent[0]?.text).toBe('<b>建议</b>: 读多写少先用 <code>SQLite</code>。');
  });

  it('[adv] escaped untrusted content in a reply is sent as inert entities, not live HTML', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    await adapter.sendMessage(String(CHAT_ID), 'user said: <script>steal()</script> & left');

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.text).toBe('user said: &lt;script&gt;steal()&lt;/script&gt; &amp; left');
    expect(bot.sent[0]?.text).not.toContain('<script>');
  });

  it('[adv] a >4096 reply is split into ordered chunks, each ≤ limit, all to the same chat', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    // Realistic long plain report (no markdown markers) → formatted HTML > 4096.
    const longReport = '数据库选型评估报告，逐项分析读写比例与并发上限。'.repeat(300); // ~7200 code units
    await adapter.sendMessage(String(CHAT_ID), longReport);

    expect(bot.sent.length).toBeGreaterThan(1);
    for (const s of bot.sent) {
      expect(s.chatId).toBe(String(CHAT_ID));
      expect(s.parseMode).toBe('HTML');
      expect(s.text.length).toBeLessThanOrEqual(LIMIT);
    }
    // Concatenated chunks reconstruct the formatted payload (plain CJK formats to itself).
    expect(bot.sent.map((s) => s.text).join('')).toBe(longReport);
  });

  it('[edge] an empty reply still sends exactly one (empty) message so the round-trip completes', async () => {
    const bot = new FakeTelegramBot();
    const adapter = createTelegramAdapter({ bot });

    await adapter.sendMessage(String(CHAT_ID), '');

    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.text).toBe('');
    expect(bot.sent[0]?.chatId).toBe(String(CHAT_ID));
  });
});
