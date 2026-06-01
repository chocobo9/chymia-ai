// M9 web runtime config — all endpoints/limits externalized (CLAUDE.md §2.1:
// no hardcoded config in code). Values come from Vite env (import.meta.env)
// with safe defaults that match the M8 dev server (Fastify + Socket.io on the
// same origin in production; configurable for split dev hosts).

/** Default API origin when no VITE_API_URL is provided (same-origin dev proxy). */
const DEFAULT_API_URL = 'http://127.0.0.1:3000';

interface RawEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SOCKET_URL?: string;
}

function readEnv(): RawEnv {
  // import.meta.env is injected by Vite; guard for non-Vite (test) runtimes.
  const meta = import.meta as unknown as { readonly env?: RawEnv };
  return meta.env ?? {};
}

/** Web app configuration resolved once at module load. */
export interface WebConfig {
  /** Base URL for HTTP API calls (no trailing slash). */
  readonly apiUrl: string;
  /** Base URL for the Socket.io connection (defaults to apiUrl). */
  readonly socketUrl: string;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Resolve the runtime config from the environment. */
export function resolveConfig(env: RawEnv = readEnv()): WebConfig {
  const apiUrl = stripTrailingSlash(env.VITE_API_URL ?? DEFAULT_API_URL);
  const socketUrl = stripTrailingSlash(env.VITE_SOCKET_URL ?? apiUrl);
  return { apiUrl, socketUrl };
}

/** Singleton config for app-wide use. */
export const webConfig: WebConfig = resolveConfig();
