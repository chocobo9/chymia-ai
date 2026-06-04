// packages/adapters/feishu/feishu-adapter.ts
// Feishu (飞书/Lark) adapter — inbound over the SDK's WebSocket LONG-CONNECTION
// (no public callback URL needed; just app_id/app_secret + "长连接" enabled on the
// app's event subscription). Outbound + token are pure HTTP (feishu-client).
//
// The WS lifecycle (start/stop) is thin glue around @larksuiteoapi/node-sdk; the
// load-bearing inbound logic lives in `handleEvent` (parse → ingress seam → reply)
// which is unit-testable WITHOUT a live socket. DM + text only (MVP).

import * as lark from '@larksuiteoapi/node-sdk';
import type { IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import {
  FeishuTokenCache,
  sendFeishuText,
  parseFeishuEvent,
  type FetchFn,
} from './feishu-client.js';

const ADAPTER_NAME = 'feishu';

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

export interface FeishuAdapterDeps {
  readonly submitPlatformMessage: SubmitPlatformMessage;
  readonly appId: string;
  readonly appSecret: string;
  /** Injectable fetch for token + send (tests). */
  readonly fetchFn?: FetchFn;
  readonly logger?: AdapterLogger;
}

/** Feishu long-connection adapter. Construct via {@link createFeishuAdapter}. */
export class FeishuAdapter {
  readonly name = ADAPTER_NAME;
  private readonly submit: SubmitPlatformMessage;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchFn: FetchFn;
  private readonly logger: AdapterLogger;
  private readonly tokenCache: FeishuTokenCache;
  private wsClient: lark.WSClient | null = null;

  constructor(deps: FeishuAdapterDeps) {
    this.submit = deps.submitPlatformMessage;
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.tokenCache = new FeishuTokenCache(this.appId, this.appSecret, this.fetchFn);
  }

  get isConnected(): boolean {
    return this.wsClient !== null;
  }

  /** Open the long connection and route im.message.receive_v1 events to handleEvent. */
  async start(): Promise<void> {
    if (this.wsClient !== null) return;
    const wsClient = new lark.WSClient({ appId: this.appId, appSecret: this.appSecret });
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown): Promise<void> => {
        await this.handleEvent(data);
      },
    });
    await wsClient.start({ eventDispatcher });
    this.wsClient = wsClient;
  }

  /** Close the long connection. */
  async stop(): Promise<void> {
    this.wsClient?.close();
    this.wsClient = null;
    return Promise.resolve();
  }

  /** Send a text reply to a Feishu chat. */
  async sendMessage(channelId: string, content: string): Promise<void> {
    const token = await this.tokenCache.get();
    await sendFeishuText(this.fetchFn, token, channelId, content);
  }

  /**
   * Inbound core (testable): parse a Feishu event → drive the ingress seam → send
   * each agent reply back to the same chat. Non-p2p / non-text events are ignored.
   */
  async handleEvent(data: unknown): Promise<void> {
    const inbound = parseFeishuEvent(data);
    if (inbound === null) return;
    const incoming: IncomingPlatformMessage = {
      adapterName: ADAPTER_NAME,
      channelId: inbound.chatId,
      platformUserId: inbound.senderId,
      platformMessageId: inbound.messageId,
      text: inbound.text,
      receivedAt: Date.now(),
    };
    try {
      const { replies } = await this.submit(incoming);
      for (const reply of replies) {
        if (reply.content.length > 0) await this.sendMessage(inbound.chatId, reply.content);
      }
    } catch (err) {
      this.logger.error({ err: String(err), chatId: inbound.chatId }, 'feishu inbound dispatch failed');
    }
  }
}

/** Factory for the Feishu (飞书) long-connection adapter. */
export function createFeishuAdapter(deps: FeishuAdapterDeps): FeishuAdapter {
  return new FeishuAdapter(deps);
}
