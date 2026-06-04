// packages/api/src/config/weixin-token-store.ts
// Persists the personal-WeChat (iLink) bot_token under ~/.choco/weixin-bot.json
// (mode 0600 — it is a live session credential). The composition root reads it at
// boot to auto-reconnect; the login flow writes it on a confirmed QR scan; logout
// clears it. Fail-open reads (missing/corrupt → no token).

import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { globalConfigPath } from '@choco/api/config/global-config';

const WEIXIN_TOKEN_FILE = 'weixin-bot.json';
const SECRET_FILE_MODE = 0o600;

interface StoredWeixinToken {
  readonly botToken?: string;
}

/** File-backed iLink bot_token store. */
export class WeixinTokenStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? globalConfigPath(WEIXIN_TOKEN_FILE);
  }

  /** The persisted bot_token, or undefined. */
  get(): string | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as StoredWeixinToken;
      return typeof parsed.botToken === 'string' && parsed.botToken.length > 0
        ? parsed.botToken
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persist a bot_token (0600). */
  set(botToken: string): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({ botToken }, null, 2), {
      encoding: 'utf-8',
      mode: SECRET_FILE_MODE,
    });
  }

  /** Remove the persisted token (logout). */
  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
