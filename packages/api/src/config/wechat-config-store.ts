// packages/api/src/config/wechat-config-store.ts
// M13 wiring — persisted WeCom (企业微信) adapter config under ~/.choco/wechat.json
// (mode 0600: it holds the app secret). The GET route reads the MASKED view
// (hasSecret only); the API composition root (main.ts) reads the full config to
// decide whether to wire the adapter at start. One small JSON file, fail-open
// reads — mirrors the trust/account stores.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WeChatSettings, WeChatSettingsView } from '@choco/shared';
import { globalConfigPath } from '@choco/api/config/global-config';

const WECHAT_FILE = 'wechat.json';
const SECRET_FILE_MODE = 0o600;

/** The path WeCom must POST callbacks to (matches the adapter's WEBHOOK_PATH). */
export const WECHAT_WEBHOOK_PATH = '/api/adapters/wechat/webhook';
/** Default WeCom API base — note the /cgi-bin suffix the WeCom endpoints live under. */
export const WECHAT_DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';

/** Full on-disk shape (includes the secrets). */
interface StoredWeChatConfig {
  readonly corpId?: string;
  readonly agentId?: string;
  readonly secret?: string;
  /** WeCom callback EncodingAESKey (decrypts inbound; required for 企业微信). */
  readonly encodingAesKey?: string;
  readonly token?: string;
  readonly apiBase?: string;
  readonly enabled?: boolean;
}

/** The full adapter config for wiring. `encodingAesKey` present ⇒ encrypted mode. */
export interface WeChatAdapterCreds {
  readonly corpId: string;
  readonly agentId: string;
  readonly secret: string;
  readonly token: string;
  readonly apiBase: string;
  readonly encodingAesKey?: string;
}

/** Fields a caller may set (empty secret/encodingAesKey clears it; omitted leaves it). */
export interface WeChatConfigPatch {
  readonly corpId?: string;
  readonly agentId?: string;
  readonly token?: string;
  readonly apiBase?: string;
  readonly enabled?: boolean;
  readonly secret?: string;
  readonly encodingAesKey?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** File-backed WeCom adapter config. Reads fail-open (missing/corrupt → empty). */
export class WeChatConfigStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? globalConfigPath(WECHAT_FILE);
  }

  private read(): StoredWeChatConfig {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      if (!isRecord(parsed)) return {};
      return {
        ...(str(parsed.corpId) !== undefined ? { corpId: str(parsed.corpId) } : {}),
        ...(str(parsed.agentId) !== undefined ? { agentId: str(parsed.agentId) } : {}),
        ...(str(parsed.secret) !== undefined ? { secret: str(parsed.secret) } : {}),
        ...(str(parsed.encodingAesKey) !== undefined ? { encodingAesKey: str(parsed.encodingAesKey) } : {}),
        ...(str(parsed.token) !== undefined ? { token: str(parsed.token) } : {}),
        ...(str(parsed.apiBase) !== undefined ? { apiBase: str(parsed.apiBase) } : {}),
        ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
      };
    } catch {
      return {};
    }
  }

  private write(cfg: StoredWeChatConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), {
      encoding: 'utf-8',
      mode: SECRET_FILE_MODE,
    });
  }

  /** Base (non-secret) settings with defaults applied. */
  private settings(cfg: StoredWeChatConfig): WeChatSettings {
    return {
      corpId: cfg.corpId ?? '',
      agentId: cfg.agentId ?? '',
      token: cfg.token ?? '',
      apiBase: cfg.apiBase !== undefined && cfg.apiBase.length > 0 ? cfg.apiBase : WECHAT_DEFAULT_API_BASE,
      enabled: cfg.enabled === true,
    };
  }

  /** The MASKED view for the GET route (no secret). */
  getView(): WeChatSettingsView {
    const cfg = this.read();
    const s = this.settings(cfg);
    const hasSecret = typeof cfg.secret === 'string' && cfg.secret.length > 0;
    const hasEncodingAesKey =
      typeof cfg.encodingAesKey === 'string' && cfg.encodingAesKey.length > 0;
    return {
      ...s,
      hasSecret,
      hasEncodingAesKey,
      webhookPath: WECHAT_WEBHOOK_PATH,
      ready:
        s.enabled &&
        s.corpId.length > 0 &&
        s.agentId.length > 0 &&
        s.token.length > 0 &&
        hasSecret,
    };
  }

  /** The FULL adapter creds (all present) for wiring, or null if incomplete/disabled. */
  resolveAdapterCreds(): WeChatAdapterCreds | null {
    const cfg = this.read();
    const s = this.settings(cfg);
    if (!s.enabled) return null;
    if (s.corpId.length === 0 || s.agentId.length === 0 || s.token.length === 0) return null;
    if (cfg.secret === undefined || cfg.secret.length === 0) return null;
    return {
      corpId: s.corpId,
      agentId: s.agentId,
      secret: cfg.secret,
      token: s.token,
      apiBase: s.apiBase,
      // Present ⇒ the adapter runs encrypted mode (WeCom). Absent ⇒ plaintext.
      ...(cfg.encodingAesKey !== undefined && cfg.encodingAesKey.length > 0
        ? { encodingAesKey: cfg.encodingAesKey }
        : {}),
    };
  }

  /** Patch the config (empty `secret` clears it). Returns the masked view. */
  set(patch: WeChatConfigPatch): WeChatSettingsView {
    const cur = this.read();
    const next: StoredWeChatConfig = {
      ...cur,
      ...(patch.corpId !== undefined ? { corpId: patch.corpId } : {}),
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.token !== undefined ? { token: patch.token } : {}),
      ...(patch.apiBase !== undefined ? { apiBase: patch.apiBase } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.secret !== undefined
        ? patch.secret.length > 0
          ? { secret: patch.secret }
          : { secret: undefined }
        : {}),
      ...(patch.encodingAesKey !== undefined
        ? patch.encodingAesKey.length > 0
          ? { encodingAesKey: patch.encodingAesKey }
          : { encodingAesKey: undefined }
        : {}),
    };
    this.write(next);
    return this.getView();
  }
}
