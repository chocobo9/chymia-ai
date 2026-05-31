// M8 BroadcastRateMonitor — per-thread broadcast rate limiting.
//
// Source: clowder-design-supplement.md §C2 (550–551): "BroadcastRateMonitor —
// 广播限流，防止高频 tool_use 事件打爆前端".
//
// WHY: a fast agent can emit tool_use/text events far faster than a browser can
// render. We bound the broadcast rate per thread with a simple token-bucket so a
// burst still flows but a sustained flood is throttled. This is advisory: the
// SocketManager asks shouldBroadcast(threadId) before emitting a high-frequency
// event; terminal events (done/error) bypass the limiter so the client always
// learns a turn ended. Pure in-memory, injected clock for tests.

/** Clock injected for deterministic tests; defaults to Date.now. */
export type NowFn = () => number;

/**
 * Token-bucket capacity per thread — the size of an allowed burst before
 * throttling engages. Sized so a normal multi-tool turn streams unthrottled.
 * Local tuning constant (no canonical Clowder value documented).
 */
const DEFAULT_BURST_CAPACITY = 40;

/**
 * Sustained refill rate (tokens per second) once the burst budget is spent.
 * ~20/s comfortably exceeds a human reading rate while taming runaway floods.
 */
const DEFAULT_REFILL_PER_SEC = 20;

export interface BroadcastRateMonitorOptions {
  /** Burst capacity per thread (default {@link DEFAULT_BURST_CAPACITY}). */
  readonly burstCapacity?: number;
  /** Sustained refill rate, tokens/sec (default {@link DEFAULT_REFILL_PER_SEC}). */
  readonly refillPerSec?: number;
  readonly now?: NowFn;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-thread token-bucket rate monitor. {@link shouldBroadcast} returns false
 * when the thread has exhausted its budget (caller should drop / coalesce the
 * event); buckets refill over time. Stateless across threads beyond the bucket map.
 */
export class BroadcastRateMonitor {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: NowFn;

  constructor(options?: BroadcastRateMonitorOptions) {
    this.capacity = options?.burstCapacity ?? DEFAULT_BURST_CAPACITY;
    this.refillPerMs = (options?.refillPerSec ?? DEFAULT_REFILL_PER_SEC) / 1000;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Whether a high-frequency event for `threadId` may be broadcast now.
   * Consumes one token on success; returns false (throttle) when empty.
   */
  shouldBroadcast(threadId: string): boolean {
    const bucket = this.refill(threadId);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Forget a thread's bucket (e.g. on thread delete) to bound memory. */
  reset(threadId: string): void {
    this.buckets.delete(threadId);
  }

  private refill(threadId: string): Bucket {
    const nowMs = this.now();
    const existing = this.buckets.get(threadId);
    if (existing === undefined) {
      const fresh: Bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(threadId, fresh);
      return fresh;
    }
    const elapsed = nowMs - existing.lastRefillMs;
    if (elapsed > 0) {
      existing.tokens = Math.min(
        this.capacity,
        existing.tokens + elapsed * this.refillPerMs,
      );
      existing.lastRefillMs = nowMs;
    }
    return existing;
  }
}
