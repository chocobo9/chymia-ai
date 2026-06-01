// M14 telegram-adapter — PlatformAdapter over a grammy Bot, long-polling only.
//
// Source: clowder-architecture-design.md §5.8 (PlatformAdapter contract) + §7.8
// (Telegram long-poll via grammy, NO public webhook; DM-first; HTML format; 4096
// split). clowder-design-supplement.md §A10 (platform-mapping seam) + §B4
// (outbound: each agent reply → format → split → send back to the same chat).
//
// Flow: a Telegram text update → build IncomingPlatformMessage → call the
// injected onMessage handler (which wires to buildApp().submitPlatformMessage)
// → that returns the agent replies → sendMessage each reply back to the chat.
//
// Injection (CLAUDE.md §2.1 no hardcoded config, constructor injection only):
// the bot token comes from config (or env CLOWDER_TELEGRAM_BOT_TOKEN at the wiring
// site, never a literal here), and the grammy Bot is injected so tests can supply
// a fake — the adapter never constructs network I/O itself.

import type { AgentId, IncomingPlatformMessage, PlatformAdapter } from '@clowder/shared';
import { formatToTelegramHtml } from './html-formatter.js';
import { splitHtmlMessage } from './message-splitter.js';

/** This adapter's stable name — matches IPlatformMappingStore adapterName. */
export const TELEGRAM_ADAPTER_NAME = 'telegram' as const;

/** Env var the wiring site reads for the bot token (never read as a literal in code). */
export const TELEGRAM_BOT_TOKEN_ENV = 'CLOWDER_TELEGRAM_BOT_TOKEN' as const;

/** Telegram parse mode we send formatted replies with (matches html-formatter output). */
const TELEGRAM_PARSE_MODE = 'HTML' as const;

/**
 * Minimal grammy Bot surface this adapter needs. A real grammy `Bot` satisfies
 * this structurally; tests inject a fake so no network call (getMe/getUpdates) is
 * made. Kept narrow on purpose — the adapter depends only on the long-poll
 * lifecycle (`start`/`stop`), the inbound text hook (`on`), and outbound
 * `api.sendMessage` (DM-only, text/HTML).
 */
export interface TelegramBotPort {
  /** Register a handler for an update filter (we use 'message:text' for DM text). */
  on(filter: 'message:text', handler: (ctx: TelegramUpdateContext) => Promise<void> | void): void;
  /** Begin long polling. Resolves only when polling stops (per grammy semantics). */
  start(options?: { drop_pending_updates?: boolean }): Promise<void>;
  /** Stop long polling and release the getUpdates loop. */
  stop(): Promise<void>;
  /** The Telegram Bot API surface — only sendMessage is needed for outbound. */
  readonly api: TelegramApiPort;
}

/** Narrow outbound surface — grammy `Api.sendMessage(chat_id, text, other?)`. */
export interface TelegramApiPort {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: { parse_mode?: 'HTML' },
  ): Promise<unknown>;
}

/**
 * Minimal shape of a grammy update context for an inbound text message. Matches
 * the fields the adapter reads off `ctx` (chat id, sender id, message id, text).
 */
export interface TelegramUpdateContext {
  readonly message?: {
    readonly message_id: number;
    readonly text?: string;
    readonly chat: { readonly id: number | string };
    readonly from?: { readonly id: number | string; readonly is_bot?: boolean };
  };
  /** Original update object retained as `raw` on the normalized message. */
  readonly update?: Record<string, unknown>;
}

/** Structured logger seam (no console.log per CLAUDE.md §2.1); defaults to silent. */
export type TelegramLogger = (event: {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly chatId?: string;
}) => void;

/** Dependencies for {@link createTelegramAdapter}. */
export interface TelegramAdapterDeps {
  /** Injected grammy Bot (real in prod, fake in tests) — never constructed here. */
  readonly bot: TelegramBotPort;
  /**
   * Drop updates queued while the bot was offline on start (avoids replaying a
   * backlog). Defaults to true. Externalized rather than hardcoded inline.
   */
  readonly dropPendingUpdates?: boolean;
  /** Structured logger; defaults to a silent no-op. */
  readonly logger?: TelegramLogger;
}

/** Silent default logger (no console.log). */
const NOOP_LOGGER: TelegramLogger = () => {};

/**
 * Build the Telegram {@link PlatformAdapter}. The returned object is the frozen
 * contract surface; the grammy Bot + config are captured by closure (immutability:
 * no post-construction mutation of deps). `onMessage` registers the system handler;
 * `start` wires the inbound text hook to it and begins long polling.
 */
export function createTelegramAdapter(deps: TelegramAdapterDeps): PlatformAdapter {
  const { bot } = deps;
  const dropPendingUpdates = deps.dropPendingUpdates ?? true;
  const log = deps.logger ?? NOOP_LOGGER;

  // Single registered inbound handler (set via onMessage before start). Held in a
  // one-field mutable cell rather than mutating deps — the public contract stays
  // immutable and the handler is replaced wholesale, never edited in place.
  let inboundHandler: ((message: IncomingPlatformMessage) => Promise<void>) | undefined;
  let started = false;

  /** Normalize a grammy text-message context into IncomingPlatformMessage, or null to skip. */
  function toIncoming(ctx: TelegramUpdateContext): IncomingPlatformMessage | null {
    const message = ctx.message;
    if (message === undefined) return null;
    const text = message.text;
    if (typeof text !== 'string') return null;
    const from = message.from;
    // Skip messages from bots (and updates without a sender).
    if (from === undefined || from.is_bot === true) return null;
    const raw = ctx.update;
    return {
      adapterName: TELEGRAM_ADAPTER_NAME,
      channelId: String(message.chat.id),
      platformUserId: String(from.id),
      platformMessageId: String(message.message_id),
      text,
      receivedAt: Date.now(),
      ...(raw !== undefined ? { raw } : {}),
    };
  }

  /** Dispatch one inbound update to the registered handler, isolating handler errors. */
  async function dispatch(ctx: TelegramUpdateContext): Promise<void> {
    const incoming = toIncoming(ctx);
    if (incoming === null) return;
    if (inboundHandler === undefined) {
      log({ level: 'warn', message: 'inbound update before onMessage registered', chatId: incoming.channelId });
      return;
    }
    try {
      await inboundHandler(incoming);
    } catch (err) {
      // A handler failure must not crash the long-poll loop.
      log({
        level: 'error',
        message: `inbound handler failed: ${err instanceof Error ? err.message : String(err)}`,
        chatId: incoming.channelId,
      });
    }
  }

  return {
    name: TELEGRAM_ADAPTER_NAME,

    onMessage(handler: (message: IncomingPlatformMessage) => Promise<void>): void {
      inboundHandler = handler;
    },

    async start(): Promise<void> {
      if (started) return;
      started = true;
      bot.on('message:text', dispatch);
      // grammy's start() resolves only when polling stops, so we DON'T await it —
      // awaiting would block start() forever. Errors are logged via catch.
      void bot.start({ drop_pending_updates: dropPendingUpdates }).catch((err: unknown) => {
        log({
          level: 'error',
          message: `long polling stopped: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
      log({ level: 'info', message: 'telegram long polling started' });
    },

    async stop(): Promise<void> {
      if (!started) return;
      started = false;
      await bot.stop();
      log({ level: 'info', message: 'telegram long polling stopped' });
    },

    async sendMessage(channelId: string, content: string, _agentId?: AgentId): Promise<void> {
      // §B4 outbound: format the reply to Telegram HTML, then split at the 4096
      // limit (tag/entity/surrogate-safe) and send each chunk in order to the chat.
      const html = formatToTelegramHtml(content);
      for (const chunk of splitHtmlMessage(html)) {
        await bot.api.sendMessage(channelId, chunk, { parse_mode: TELEGRAM_PARSE_MODE });
      }
    },
  };
}
