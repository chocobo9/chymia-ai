// packages/api/src/runtime/feishu-manager.ts
// Lifecycle owner for the Feishu (飞书) long-connection adapter. Config-driven:
// saving a complete+enabled config (re)connects the WS at runtime (no restart —
// long-connection registers no routes); disabling/clearing disconnects. The
// composition root calls autoStart() at boot to reconnect a persisted config.
//
// The adapter factory is injectable so tests drive the config lifecycle WITHOUT
// opening a real WebSocket to Feishu.

import {
  createFeishuAdapter,
  type SubmitPlatformMessage,
  type AdapterLogger,
  type FetchFn,
  type FeishuAdapterDeps,
} from '@choco/adapters/feishu';
import {
  FeishuConfigStore,
  type FeishuConfigView,
  type FeishuConfigPatch,
} from '@choco/api/config/feishu-config-store';

/** The slice of FeishuAdapter the manager drives (so tests can fake it). */
export interface FeishuAdapterLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly isConnected: boolean;
  /**
   * Send a markdown text to a 飞书 channel out-of-band (NOT a reply to an inbound
   * message) — the web→飞书 bridge for a turn that originated off-platform.
   * Optional so existing fakes need not implement it; the manager no-ops when absent.
   */
  sendToChannel?(channelId: string, text: string): Promise<void>;
}

export interface FeishuManagerDeps {
  readonly submitPlatformMessage: SubmitPlatformMessage;
  readonly fetchFn?: FetchFn;
  readonly logger?: AdapterLogger;
  readonly store?: FeishuConfigStore;
  /** Adapter factory (default builds the real WS adapter; tests inject a fake). */
  readonly adapterFactory?: (deps: FeishuAdapterDeps) => FeishuAdapterLike;
}

const NOOP_LOGGER: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface FeishuStatus {
  readonly connected: boolean;
  readonly ready: boolean;
}

export class FeishuManager {
  private readonly submit: SubmitPlatformMessage;
  private readonly fetchFn: FetchFn;
  private readonly logger: AdapterLogger;
  private readonly store: FeishuConfigStore;
  private readonly makeAdapter: (deps: FeishuAdapterDeps) => FeishuAdapterLike;
  private adapter: FeishuAdapterLike | null = null;

  constructor(deps: FeishuManagerDeps) {
    this.submit = deps.submitPlatformMessage;
    this.fetchFn = deps.fetchFn ?? globalThis.fetch;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.store = deps.store ?? new FeishuConfigStore();
    this.makeAdapter = deps.adapterFactory ?? createFeishuAdapter;
  }

  getView(): FeishuConfigView {
    return this.store.getView();
  }

  status(): FeishuStatus {
    return {
      connected: this.adapter !== null && this.adapter.isConnected,
      ready: this.store.getView().ready,
    };
  }

  /** Set config, then connect/disconnect to match it. Returns the masked view. */
  async applyConfig(patch: FeishuConfigPatch): Promise<FeishuConfigView> {
    const view = this.store.set(patch);
    await this.reconcile();
    return view;
  }

  /** Connect if a persisted config is complete + enabled (boot). */
  async autoStart(): Promise<void> {
    await this.reconcile();
  }

  /**
   * web→飞书 bridge: send `text` to a 飞书 channel out-of-band. No-op when not
   * connected or the live adapter can't send (best-effort; never throws to caller).
   */
  async sendToChannel(channelId: string, text: string): Promise<void> {
    const adapter = this.adapter;
    if (adapter === null || !adapter.isConnected || adapter.sendToChannel === undefined) {
      return;
    }
    try {
      await adapter.sendToChannel(channelId, text);
    } catch (err) {
      this.logger.error({ err: String(err), channelId }, 'feishu: outbound sendToChannel failed');
    }
  }

  private async reconcile(): Promise<void> {
    const creds = this.store.resolveCreds();
    await this.stopAdapter();
    if (creds === null) return;
    const adapter = this.makeAdapter({
      submitPlatformMessage: this.submit,
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: creds.domain,
      fetchFn: this.fetchFn,
      logger: this.logger,
    });
    try {
      await adapter.start();
      this.adapter = adapter;
      this.logger.info({}, 'feishu: long connection established');
    } catch (err) {
      this.adapter = null;
      this.logger.error({ err: String(err) }, 'feishu: failed to connect');
    }
  }

  private async stopAdapter(): Promise<void> {
    if (this.adapter !== null) {
      await this.adapter.stop();
      this.adapter = null;
    }
  }
}
