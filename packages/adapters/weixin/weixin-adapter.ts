// packages/adapters/weixin/weixin-adapter.ts
// Personal-WeChat adapter over the iLink Bot protocol (ilink-client). Unlike the
// WeCom adapter (inbound webhook), this is a LONG-POLL adapter: start() runs a
// loop that POSTs getupdates, routes each inbound text through the ingress seam,
// and sends the agent replies back via sendmessage (using the per-chat
// context_token cached from the inbound message). DM + text only (MVP).

import type { AgentId, IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import {
  fetchQrCode,
  pollQrCodeStatus,
  getUpdates,
  sendText,
  type FetchFn,
  type QrCode,
  type QrStatus,
} from './ilink-client.js';

const ADAPTER_NAME = 'weixin';
const POLL_ERROR_BACKOFF_MS = 3_000;

/** Re-export the QR helpers so the API layer drives login without importing the client. */
export { type QrCode, type QrStatus };
export async function requestQrCode(fetchFn: FetchFn = globalThis.fetch): Promise<QrCode> {
  return fetchQrCode(fetchFn);
}
export async function checkQrStatus(qrPayload: string, fetchFn: FetchFn = globalThis.fetch): Promise<QrStatus> {
  return pollQrCodeStatus(fetchFn, qrPayload);
}

/** Result of the platform-ingress seam (mirrors app-factory PlatformIngressResult). */
export interface IngressResult {
  readonly threadId: string;
  readonly userId: string;
  readonly replies: StoredMessage[];
}

/** The ingress seam an adapter drives for one inbound message. */
export type SubmitPlatformMessage = (incoming: IncomingPlatformMessage) => Promise<IngressResult>;

/** Structured logger seam (no console.log per project rules). */
export interface AdapterLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface WeixinAdapterDeps {
  readonly submitPlatformMessage: SubmitPlatformMessage;
  /** The bot_token obtained from the QR login. */
  readonly botToken: string;
  /** Injectable fetch (tests). */
  readonly fetchFn?: FetchFn;
  readonly logger?: AdapterLogger;
  /** Called when the bot_token expires (errcode -14) so the manager can re-login. */
  readonly onSessionExpired?: () => void;
  /** Injectable sleep (tests pass a no-wait stub to avoid real backoff delays). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Personal-WeChat (iLink) long-poll adapter. Construct via {@link createWeixinAdapter}. */
export class WeixinAdapter {
  readonly name = ADAPTER_NAME;
  private readonly submit: SubmitPlatformMessage;
  private readonly botToken: string;
  private readonly fetchFn: FetchFn;
  private readonly logger: AdapterLogger;
  private readonly onSessionExpired?: () => void;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Per-chat reply token cached from the latest inbound message of that chat. */
  private readonly contextTokens = new Map<string, string>();
  private cursor = '';
  private polling = false;
  private abort: AbortController | null = null;
  private loopDone: Promise<void> | null = null;

  constructor(deps: WeixinAdapterDeps) {
    this.submit = deps.submitPlatformMessage;
    this.botToken = deps.botToken;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.onSessionExpired = deps.onSessionExpired;
    this.sleep = deps.sleep ?? realSleep;
  }

  get isPolling(): boolean {
    return this.polling;
  }

  /** Begin the long-poll loop (idempotent). */
  start(): void {
    if (this.polling) return;
    this.polling = true;
    this.loopDone = this.loop();
  }

  /** Stop the loop + abort the in-flight poll. Resolves once the loop has exited. */
  async stop(): Promise<void> {
    this.polling = false;
    this.abort?.abort();
    if (this.loopDone !== null) await this.loopDone.catch(() => {});
    this.loopDone = null;
  }

  /** Send a text reply to a WeChat chat (needs a cached context_token for it). */
  async sendMessage(channelId: string, content: string): Promise<void> {
    const token = this.contextTokens.get(channelId);
    if (token === undefined) {
      this.logger.warn({ channelId }, 'weixin: no context_token for chat — cannot reply');
      return;
    }
    await sendText(this.fetchFn, this.botToken, channelId, token, content);
  }

  private async loop(): Promise<void> {
    while (this.polling) {
      try {
        this.abort = new AbortController();
        const { messages, newCursor, sessionExpired } = await getUpdates(
          this.fetchFn,
          this.botToken,
          this.cursor,
          this.abort.signal,
        );
        if (sessionExpired) {
          this.logger.error({}, 'weixin: session expired (errcode -14) — needs re-login');
          this.polling = false;
          this.onSessionExpired?.();
          break;
        }
        this.cursor = newCursor;
        for (const msg of messages) {
          this.contextTokens.set(msg.chatId, msg.contextToken);
          await this.dispatchAndReply(msg.chatId, msg.text, msg.messageId, msg.createdAtMs);
        }
      } catch (err) {
        if (!this.polling) break; // aborted by stop()
        this.logger.warn({ err: String(err) }, 'weixin: getupdates failed — backing off');
        await this.sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  private async dispatchAndReply(
    chatId: string,
    text: string,
    messageId: string,
    createdAtMs: number | undefined,
  ): Promise<void> {
    const incoming: IncomingPlatformMessage = {
      adapterName: ADAPTER_NAME,
      channelId: chatId,
      platformUserId: chatId,
      platformMessageId: messageId,
      text,
      receivedAt: createdAtMs ?? Date.now(),
    };
    try {
      const { replies } = await this.submit(incoming);
      for (const reply of replies) {
        if (reply.content.length > 0) await this.sendMessage(chatId, reply.content);
      }
    } catch (err) {
      this.logger.error({ chatId, err: String(err) }, 'weixin: inbound dispatch failed');
    }
  }
}

/** Map an agent id onto the optional reply attribution (reserved; DM is single-agent-ish). */
export type { AgentId };

/** Factory for the personal-WeChat (iLink) adapter. */
export function createWeixinAdapter(deps: WeixinAdapterDeps): WeixinAdapter {
  return new WeixinAdapter(deps);
}
