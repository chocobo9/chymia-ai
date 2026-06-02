// Test fake for the grammy Bot surface the M14 adapter depends on
// (TelegramBotPort). No network: it captures the registered 'message:text'
// handler so a test can simulate an inbound update, and records every outbound
// api.sendMessage call so a test can assert formatting/splitting/chat routing.

import type {
  TelegramApiPort,
  TelegramBotPort,
  TelegramUpdateContext,
} from '@choco/adapters/telegram/telegram-adapter';

/** One recorded outbound send. */
export interface SentMessage {
  readonly chatId: number | string;
  readonly text: string;
  readonly parseMode: 'HTML' | undefined;
}

/** A no-network grammy Bot stand-in implementing the adapter's TelegramBotPort. */
export class FakeTelegramBot implements TelegramBotPort {
  readonly sent: SentMessage[] = [];
  startCalls = 0;
  stopCalls = 0;
  private textHandler: ((ctx: TelegramUpdateContext) => Promise<void> | void) | undefined;
  private startResolve: (() => void) | undefined;

  readonly api: TelegramApiPort = {
    sendMessage: async (
      chatId: number | string,
      text: string,
      other?: { parse_mode?: 'HTML' },
    ): Promise<unknown> => {
      this.sent.push({ chatId, text, parseMode: other?.parse_mode });
      return { message_id: this.sent.length };
    },
  };

  on(
    _filter: 'message:text',
    handler: (ctx: TelegramUpdateContext) => Promise<void> | void,
  ): void {
    this.textHandler = handler;
  }

  // grammy's start() resolves only when polling stops; mirror that — it stays
  // pending until stop() is called, so the adapter must not await it.
  start(_options?: { drop_pending_updates?: boolean }): Promise<void> {
    this.startCalls += 1;
    return new Promise<void>((resolve) => {
      this.startResolve = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.startResolve?.();
  }

  /** Simulate an inbound Telegram text update reaching the registered handler. */
  async emitText(ctx: TelegramUpdateContext): Promise<void> {
    if (this.textHandler === undefined) {
      throw new Error('no message:text handler registered (adapter.start not called)');
    }
    await this.textHandler(ctx);
  }
}

/** Build a realistic grammy text-message update context (private DM). */
export function textUpdate(args: {
  readonly chatId: number;
  readonly userId: number;
  readonly messageId: number;
  readonly text: string;
}): TelegramUpdateContext {
  const message = {
    message_id: args.messageId,
    text: args.text,
    chat: { id: args.chatId, type: 'private' as const },
    from: { id: args.userId, is_bot: false },
  };
  return { message, update: { update_id: args.messageId, message } };
}
