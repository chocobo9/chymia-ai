// packages/api/src/runtime/weixin-manager.ts
// Lifecycle owner for the personal-WeChat (iLink) adapter: the QR login flow + the
// running long-poll adapter. The routes drive login/status/logout through it; the
// composition root (main.ts) calls autoStart() to reconnect a persisted session.
//
// One adapter at a time (MVP, single-account). A session-expired bot_token is
// cleared so the user re-scans.

import type {
  SubmitPlatformMessage,
  AdapterLogger,
  QrCode,
  QrStatus,
} from '@choco/adapters/weixin';
import {
  createWeixinAdapter,
  requestQrCode,
  checkQrStatus,
  type FetchFn,
  type WeixinAdapter,
} from '@choco/adapters/weixin';
import { WeixinTokenStore } from '@choco/api/config/weixin-token-store';

export interface WeixinManagerDeps {
  readonly submitPlatformMessage: SubmitPlatformMessage;
  readonly fetchFn?: FetchFn;
  readonly logger?: AdapterLogger;
  readonly tokenStore?: WeixinTokenStore;
}

const NOOP_LOGGER: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Current connection state surfaced to the UI. */
export interface WeixinStatus {
  readonly connected: boolean;
  readonly hasToken: boolean;
}

export class WeixinManager {
  private readonly submit: SubmitPlatformMessage;
  private readonly fetchFn: FetchFn;
  private readonly logger: AdapterLogger;
  private readonly tokenStore: WeixinTokenStore;
  private adapter: WeixinAdapter | null = null;

  constructor(deps: WeixinManagerDeps) {
    this.submit = deps.submitPlatformMessage;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.tokenStore = deps.tokenStore ?? new WeixinTokenStore();
  }

  /** Reconnect a persisted session at boot (no-op when no token). */
  autoStart(): void {
    const token = this.tokenStore.get();
    if (token === undefined) return;
    this.startAdapter(token);
    this.logger.info({}, 'weixin: reconnected persisted session');
  }

  /** Begin a QR login: fetch a fresh QR to render + poll. */
  async loginStart(): Promise<QrCode> {
    return requestQrCode(this.fetchFn);
  }

  /**
   * Poll a QR's status. On 'confirmed' the bot_token is persisted and the adapter
   * starts polling immediately (no restart). Returns the status WITHOUT the token.
   */
  async loginPoll(qrPayload: string): Promise<QrStatus> {
    const result = await checkQrStatus(qrPayload, this.fetchFn);
    if (result.status === 'confirmed') {
      this.tokenStore.set(result.botToken);
      this.startAdapter(result.botToken);
      this.logger.info({}, 'weixin: login confirmed — adapter started');
    }
    return result;
  }

  status(): WeixinStatus {
    return {
      connected: this.adapter !== null && this.adapter.isPolling,
      hasToken: this.tokenStore.get() !== undefined,
    };
  }

  /** Stop polling + forget the token (full logout). */
  async logout(): Promise<void> {
    await this.stopAdapter();
    this.tokenStore.clear();
    this.logger.info({}, 'weixin: logged out');
  }

  private startAdapter(botToken: string): void {
    void this.stopAdapter();
    this.adapter = createWeixinAdapter({
      submitPlatformMessage: this.submit,
      botToken,
      fetchFn: this.fetchFn,
      logger: this.logger,
      onSessionExpired: () => {
        // bot_token died → drop it so the UI prompts a re-scan.
        this.tokenStore.clear();
        this.adapter = null;
        this.logger.warn({}, 'weixin: session expired — token cleared, re-scan needed');
      },
    });
    this.adapter.start();
  }

  private async stopAdapter(): Promise<void> {
    if (this.adapter !== null) {
      await this.adapter.stop();
      this.adapter = null;
    }
  }
}
