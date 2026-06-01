// M13 WeChat adapter — WeCom access_token fetch + cache + refresh.
//
// Source: clowder-design-supplement.md §A10/B4 context (adapter needs a valid
// outbound credential to push replies). WHY/edge-cases referenced from
// reference/clowder-ai-main WeComAgentAdapter.getAccessToken (7200s TTL, refresh
// margin, errcode handling) — re-implemented here, NOT copied.
//
// WeCom returns: { access_token, expires_in (seconds), errcode?, errmsg? }.
// We cache the token until (expiry - margin) to avoid using a token that lapses
// mid-request, and expose forceRefresh() so the adapter can recover from a
// 40001 "invalid credential" after a server-side rotation.

/** Minimal fetch surface the token manager needs (injectable for tests). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Config for {@link TokenManager}. corpId/secret/baseUrl come from env/config — never literals. */
export interface TokenManagerConfig {
  /** WeCom corpId (CLOWDER_WECHAT_CORP_ID). */
  readonly corpId: string;
  /** WeCom app secret (CLOWDER_WECHAT_SECRET). */
  readonly secret: string;
  /** API base (CLOWDER_WECHAT_API_BASE), e.g. https://qyapi.weixin.qq.com/cgi-bin. */
  readonly apiBase: string;
  /** Injectable HTTP. Defaults to globalThis.fetch. */
  readonly fetchFn?: FetchFn;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  readonly now?: () => number;
}

/** Shape of the WeCom gettoken JSON response. */
interface GetTokenResponse {
  readonly errcode?: number;
  readonly errmsg?: string;
  readonly access_token?: string;
  readonly expires_in?: number;
}

// Refresh margin: drop a cached token this long before its real expiry so an
// in-flight send never uses a token that lapses mid-request.
// Source: WeCom token TTL is 7200s; margin matches reference TOKEN_REFRESH_MARGIN_MS.
const TOKEN_REFRESH_MARGIN_MS = 120_000;

// Fallback TTL (seconds) when the response omits expires_in. WeCom default is 7200s.
const DEFAULT_TOKEN_TTL_SECONDS = 7200;

// Network timeout for the gettoken call.
const GETTOKEN_TIMEOUT_MS = 10_000;

const SECONDS_TO_MS = 1000;

/**
 * TokenManager — caches a WeCom access_token and refreshes it by expiry.
 *
 * Immutable cache state is replaced wholesale on each refresh (no in-place
 * mutation of a shared object). Concurrent getToken() calls during a refresh
 * share the single in-flight promise rather than firing duplicate requests.
 */
export class TokenManager {
  private readonly corpId: string;
  private readonly secret: string;
  private readonly apiBase: string;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  private cachedToken: string | null = null;
  private expiresAtMs = 0;
  private inFlight: Promise<string> | null = null;

  constructor(config: TokenManagerConfig) {
    if (config.corpId.length === 0 || config.secret.length === 0) {
      throw new Error('TokenManager: corpId and secret are required');
    }
    if (config.apiBase.length === 0) {
      throw new Error('TokenManager: apiBase is required');
    }
    this.corpId = config.corpId;
    this.secret = config.secret;
    this.apiBase = config.apiBase.replace(/\/+$/, '');
    this.fetchFn = config.fetchFn ?? globalThis.fetch;
    this.now = config.now ?? Date.now;
  }

  /**
   * Return a valid access_token, refreshing from WeCom if the cache is empty or
   * within the refresh margin of expiry. Coalesces concurrent refreshes.
   */
  async getToken(): Promise<string> {
    if (this.cachedToken !== null && this.now() < this.expiresAtMs) {
      return this.cachedToken;
    }
    if (this.inFlight !== null) {
      return this.inFlight;
    }
    const request = this.refresh();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      this.inFlight = null;
    }
  }

  /** Drop the cached token so the next getToken() forces a network refresh. */
  forceRefresh(): void {
    this.cachedToken = null;
    this.expiresAtMs = 0;
  }

  private async refresh(): Promise<string> {
    const url =
      `${this.apiBase}/gettoken` +
      `?corpid=${encodeURIComponent(this.corpId)}` +
      `&corpsecret=${encodeURIComponent(this.secret)}`;

    const res = await this.fetchFn(url, {
      signal: AbortSignal.timeout(GETTOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`WeChat gettoken HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as GetTokenResponse;
    if (typeof data.errcode === 'number' && data.errcode !== 0) {
      throw new Error(
        `WeChat gettoken errcode ${data.errcode}: ${data.errmsg ?? 'unknown'}`,
      );
    }
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new Error('WeChat gettoken: missing access_token in response');
    }

    const ttlSeconds = typeof data.expires_in === 'number' && data.expires_in > 0
      ? data.expires_in
      : DEFAULT_TOKEN_TTL_SECONDS;

    this.cachedToken = data.access_token;
    this.expiresAtMs = this.now() + ttlSeconds * SECONDS_TO_MS - TOKEN_REFRESH_MARGIN_MS;
    return data.access_token;
  }
}
