// useHealth — probes the M8 GET /health endpoint once when `active` becomes true
// and exposes the live connection state for the ConnStrip. This is REAL wiring:
// the strip's 本地 API / Socket cards reflect whether the probe succeeded; the
// 上游模型 card is honestly marked unknown (the API has no upstream-status probe).

import { useEffect, useState } from 'react';
import type { ApiClient } from '../lib/api.js';

/** Resolved connection state from a /health probe. */
export type HealthState = 'loading' | 'ok' | 'down';

export interface HealthInfo {
  readonly state: HealthState;
  /** Process uptime (ms) when ok; undefined otherwise. */
  readonly uptimeMs?: number;
  /** Epoch ms of the last successful probe; undefined until one succeeds. */
  readonly probedAt?: number;
}

/** Probe GET /health once whenever `active` flips true. */
export function useHealth(client: ApiClient, active: boolean): HealthInfo {
  const [info, setInfo] = useState<HealthInfo>({ state: 'loading' });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setInfo({ state: 'loading' });
    void (async () => {
      try {
        const payload = await client.health();
        if (cancelled) return;
        setInfo({ state: 'ok', uptimeMs: payload.uptimeMs, probedAt: payload.timestamp });
      } catch {
        if (!cancelled) setInfo({ state: 'down' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, active]);

  return info;
}
