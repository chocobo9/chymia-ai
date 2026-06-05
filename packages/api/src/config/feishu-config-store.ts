// packages/api/src/config/feishu-config-store.ts
// Persisted Feishu (飞书) app config under ~/.choco/feishu.json (mode 0600 — it
// holds the app secret). The app_secret is WRITE-ONLY across the API boundary
// (the view returns hasAppSecret only). Long-connection mode → no callback URL, so
// the config is just app_id + app_secret + enabled. Fail-open reads.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { globalConfigPath } from '@choco/api/config/global-config';

const FEISHU_FILE = 'feishu.json';
const SECRET_FILE_MODE = 0o600;

/**
 * Which open-platform region the app lives on — picks the long-connection gateway
 * domain. 'feishu' = 飞书 China (open.feishu.cn); 'lark' = Lark International
 * (open.larksuite.com). A wrong choice fails the WS handshake with Feishu error
 * `1000040351 Incorrect domain name` at pullConnectConfig. Default 'feishu'.
 */
export type FeishuDomain = 'feishu' | 'lark';
const DEFAULT_DOMAIN: FeishuDomain = 'feishu';

interface StoredFeishuConfig {
  readonly appId?: string;
  readonly appSecret?: string;
  readonly enabled?: boolean;
  readonly domain?: FeishuDomain;
}

/** The full creds the manager wires (both present, + resolved domain). */
export interface FeishuCreds {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: FeishuDomain;
}

/** The MASKED view the GET route returns (no secret). */
export interface FeishuConfigView {
  readonly appId: string;
  readonly enabled: boolean;
  readonly hasAppSecret: boolean;
  readonly domain: FeishuDomain;
  /** enabled && appId && appSecret present → would connect. */
  readonly ready: boolean;
}

/** Fields a caller may set (empty appSecret clears it; omitted leaves it). */
export interface FeishuConfigPatch {
  readonly appId?: string;
  readonly appSecret?: string;
  readonly enabled?: boolean;
  readonly domain?: FeishuDomain;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function domainOf(v: unknown): FeishuDomain | undefined {
  return v === 'feishu' || v === 'lark' ? v : undefined;
}

/** File-backed Feishu config. */
export class FeishuConfigStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? globalConfigPath(FEISHU_FILE);
  }

  private read(): StoredFeishuConfig {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Record<string, unknown>;
      return {
        ...(str(parsed.appId) !== undefined ? { appId: str(parsed.appId) } : {}),
        ...(str(parsed.appSecret) !== undefined ? { appSecret: str(parsed.appSecret) } : {}),
        ...(typeof parsed.enabled === 'boolean' ? { enabled: parsed.enabled } : {}),
        ...(domainOf(parsed.domain) !== undefined ? { domain: domainOf(parsed.domain) } : {}),
      };
    } catch {
      return {};
    }
  }

  private write(cfg: StoredFeishuConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(cfg, null, 2), {
      encoding: 'utf-8',
      mode: SECRET_FILE_MODE,
    });
  }

  getView(): FeishuConfigView {
    const cfg = this.read();
    const appId = cfg.appId ?? '';
    const hasAppSecret = typeof cfg.appSecret === 'string' && cfg.appSecret.length > 0;
    return {
      appId,
      enabled: cfg.enabled === true,
      hasAppSecret,
      domain: cfg.domain ?? DEFAULT_DOMAIN,
      ready: cfg.enabled === true && appId.length > 0 && hasAppSecret,
    };
  }

  /** The full creds for wiring, or null if disabled/incomplete. */
  resolveCreds(): FeishuCreds | null {
    const cfg = this.read();
    if (cfg.enabled !== true) return null;
    if (cfg.appId === undefined || cfg.appId.length === 0) return null;
    if (cfg.appSecret === undefined || cfg.appSecret.length === 0) return null;
    return { appId: cfg.appId, appSecret: cfg.appSecret, domain: cfg.domain ?? DEFAULT_DOMAIN };
  }

  set(patch: FeishuConfigPatch): FeishuConfigView {
    const cur = this.read();
    const next: StoredFeishuConfig = {
      ...cur,
      ...(patch.appId !== undefined ? { appId: patch.appId } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.domain !== undefined ? { domain: patch.domain } : {}),
      ...(patch.appSecret !== undefined
        ? patch.appSecret.length > 0
          ? { appSecret: patch.appSecret }
          : { appSecret: undefined }
        : {}),
    };
    this.write(next);
    return this.getView();
  }
}
