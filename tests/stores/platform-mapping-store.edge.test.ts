// G4 QA — SqlitePlatformMappingStore edge + adversarial coverage (dev≠QA).
//
// Independently authored against the FROZEN A10 contract (resolveThread /
// resolveUser find-or-create + getChannelId reverse), NOT from the dev's
// happy-path file. Attacks idempotency under concurrency, PK type-isolation,
// cross-adapter isolation, reverse-lookup correctness, and odd inputs
// (empty / very long / unicode-CJK / whitespace / collision-shaped strings).
// Real platform-shaped ids (WeChat gh_/OpenID, Telegram numeric chat ids),
// real CJK content — no placeholder data (CLAUDE §2.2).

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqlitePlatformMappingStore } from '@choco/api/stores/platform-mapping-store';
import { PLATFORM_MAPPINGS_TABLE } from '@choco/api/stores/migrations/004-platform-mappings.js';

/** Monotonic clock: strictly increasing epoch-ms per call (deterministic created_at). */
function makeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => {
    t += 1000;
    return t;
  };
}

// Real platform identifiers (not placeholders).
const WECHAT = 'wechat';
const TELEGRAM = 'telegram';
const WECHAT_OPENID = 'oABCdEf1234567890ghijklmnop';
const WECHAT_CHANNEL = 'gh_a1b2c3d4e5f6';
const TELEGRAM_CHAT_ID = '-1001987654321';
const TELEGRAM_USER_ID = '529384716';

/** Count rows for an (adapter, type) pair directly — the store hides the table. */
function rowCount(db: Database.Database, adapter: string, type: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${PLATFORM_MAPPINGS_TABLE} WHERE adapter_name = ? AND type = ?`,
    )
    .get(adapter, type) as { n: number };
  return row.n;
}

/** Count rows for an exact (adapter, platform_id, type) key. */
function keyRowCount(
  db: Database.Database,
  adapter: string,
  platformId: string,
  type: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${PLATFORM_MAPPINGS_TABLE}
       WHERE adapter_name = ? AND platform_id = ? AND type = ?`,
    )
    .get(adapter, platformId, type) as { n: number };
  return row.n;
}

describe('SqlitePlatformMappingStore idempotency under concurrency (adversarial)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('20 parallel resolveThread for one channel mint exactly ONE id and ONE row', async () => {
    // Fire-and-race: a webhook burst can call resolveThread for the same channel
    // concurrently. The find-or-create txn must collapse them to a single row.
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => store.resolveThread(WECHAT, WECHAT_CHANNEL)),
    );

    const unique = new Set(ids);
    expect(unique.size).toBe(1); // all callers observe the same internal threadId
    expect(keyRowCount(db, WECHAT, WECHAT_CHANNEL, 'thread')).toBe(1); // no dup rows
  });

  it('20 parallel resolveUser for one platform user mint exactly ONE id and ONE row', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => store.resolveUser(TELEGRAM, TELEGRAM_USER_ID)),
    );
    expect(new Set(ids).size).toBe(1);
    expect(keyRowCount(db, TELEGRAM, TELEGRAM_USER_ID, 'user')).toBe(1);
  });

  it('interleaved parallel resolves across many distinct channels create one row each', async () => {
    const channels = Array.from({ length: 30 }, (_unused, i) => `gh_chan_${i.toString(36)}`);
    // Resolve each channel TWICE concurrently → 30 distinct ids, 30 rows (not 60).
    const calls = channels.flatMap((c) => [
      store.resolveThread(WECHAT, c),
      store.resolveThread(WECHAT, c),
    ]);
    const ids = await Promise.all(calls);

    expect(new Set(ids).size).toBe(channels.length); // 30 distinct threads
    expect(rowCount(db, WECHAT, 'thread')).toBe(channels.length); // no duplicate inserts
  });
});

describe('SqlitePlatformMappingStore PK type-isolation (edge)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('the SAME platform string used as thread AND user does not collide (PK type discriminator)', async () => {
    // A WeChat OpenID can legitimately appear as both a 1:1 chat channel and the
    // user inside it. The composite PK includes `type`, so the two must not merge.
    const asThread = await store.resolveThread(WECHAT, WECHAT_OPENID);
    const asUser = await store.resolveUser(WECHAT, WECHAT_OPENID);

    expect(asThread).not.toBe(asUser);
    expect(asThread).toMatch(/^thread_wechat_/);
    expect(asUser).toMatch(/^user_wechat_/);
    // Two rows: same (adapter, platform_id) but different type.
    expect(keyRowCount(db, WECHAT, WECHAT_OPENID, 'thread')).toBe(1);
    expect(keyRowCount(db, WECHAT, WECHAT_OPENID, 'user')).toBe(1);
  });

  it('getChannelId(thread type) does NOT reverse-resolve a userId mapping of the same string', async () => {
    // Reverse lookup is type-scoped to 'thread'. A user mapping whose internal id
    // happens to be probed must return null (no cross-type leakage).
    const userId = await store.resolveUser(WECHAT, WECHAT_OPENID);
    const channel = await store.getChannelId(WECHAT, userId);
    expect(channel).toBeNull();
  });
});

describe('SqlitePlatformMappingStore cross-adapter isolation (edge)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('the SAME channelId under two adapters resolves to two INDEPENDENT threads', async () => {
    // A numeric id could coincidentally be identical on two platforms; adapter_name
    // is part of the PK so they must stay independent.
    const shared = '584213099';
    const wechatThread = await store.resolveThread(WECHAT, shared);
    const telegramThread = await store.resolveThread(TELEGRAM, shared);

    expect(wechatThread).not.toBe(telegramThread);
    expect(keyRowCount(db, WECHAT, shared, 'thread')).toBe(1);
    expect(keyRowCount(db, TELEGRAM, shared, 'thread')).toBe(1);
  });

  it('getChannelId is adapter-scoped: a thread minted under wechat is null under telegram', async () => {
    const threadId = await store.resolveThread(WECHAT, WECHAT_CHANNEL);
    expect(await store.getChannelId(WECHAT, threadId)).toBe(WECHAT_CHANNEL);
    // Same internal id probed under the WRONG adapter must not resolve.
    expect(await store.getChannelId(TELEGRAM, threadId)).toBeNull();
  });

  it('two different channels under one adapter resolve to two different threads', async () => {
    const a = await store.resolveThread(TELEGRAM, TELEGRAM_CHAT_ID);
    const b = await store.resolveThread(TELEGRAM, '-1009999000111');
    expect(a).not.toBe(b);
    expect(await store.getChannelId(TELEGRAM, a)).toBe(TELEGRAM_CHAT_ID);
    expect(await store.getChannelId(TELEGRAM, b)).toBe('-1009999000111');
  });
});

describe('SqlitePlatformMappingStore odd inputs (edge + adversarial)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('an empty-string channelId is stored as its own distinct key (does not crash)', async () => {
    const empty = await store.resolveThread(WECHAT, '');
    const real = await store.resolveThread(WECHAT, WECHAT_CHANNEL);
    expect(empty).toMatch(/^thread_wechat_/);
    expect(empty).not.toBe(real); // '' is a distinct key, not merged with a real one
    // Reverse-resolves back to the empty channel string verbatim.
    expect(await store.getChannelId(WECHAT, empty)).toBe('');
  });

  it('a very long (4KB) channelId round-trips intact and is idempotent', async () => {
    const longId = `gh_${'a1b2c3'.repeat(700)}`; // > 4000 chars
    const first = await store.resolveThread(WECHAT, longId);
    const second = await store.resolveThread(WECHAT, longId);
    expect(second).toBe(first);
    expect(await store.getChannelId(WECHAT, first)).toBe(longId);
    expect(keyRowCount(db, WECHAT, longId, 'thread')).toBe(1);
  });

  it('CJK / emoji unicode channelId is preserved byte-exactly and not merged with a near-variant', async () => {
    const cjk = '群聊_产品评审_2026春🚀';
    const variant = '群聊_产品评审_2026春'; // same prefix, no emoji → MUST be distinct
    const a = await store.resolveThread(WECHAT, cjk);
    const b = await store.resolveThread(WECHAT, variant);
    expect(a).not.toBe(b);
    expect(await store.getChannelId(WECHAT, a)).toBe(cjk);
    expect(await store.getChannelId(WECHAT, b)).toBe(variant);
  });

  it('whitespace-only and trimmed-equivalent channelIds are kept as DISTINCT keys (no silent trim/merge)', async () => {
    // Silently trimming would merge two genuinely different platform conversations.
    const spaced = ` ${WECHAT_CHANNEL} `;
    const tab = `\t${WECHAT_CHANNEL}`;
    const exact = await store.resolveThread(WECHAT, WECHAT_CHANNEL);
    const padded = await store.resolveThread(WECHAT, spaced);
    const tabbed = await store.resolveThread(WECHAT, tab);

    expect(new Set([exact, padded, tabbed]).size).toBe(3);
    expect(rowCount(db, WECHAT, 'thread')).toBe(3);
  });

  it('a channelId shaped like an INTERNAL minted id is still treated as an opaque platform key', async () => {
    // Adversarial: a platform sends a string that looks like our own minted id.
    // It must be stored as a platform_id, not confused with an internal_id.
    const spoof = 'thread_wechat_000001700000001_deadbeef';
    const minted = await store.resolveThread(WECHAT, spoof);
    expect(minted).not.toBe(spoof); // we mint a fresh internal id; spoof is the platform key
    // Forward: the spoof string resolves to the freshly minted id.
    expect(await store.resolveThread(WECHAT, spoof)).toBe(minted);
    // Reverse on the spoof-as-internal-id must be null (it was never a minted id).
    expect(await store.getChannelId(WECHAT, spoof)).toBeNull();
  });

  it('a SQL-injection-shaped channelId is bound as a parameter, not interpreted (table survives)', async () => {
    const inject = `gh'); DROP TABLE ${PLATFORM_MAPPINGS_TABLE};--`;
    const id = await store.resolveThread(WECHAT, inject);
    expect(id).toMatch(/^thread_wechat_/);
    // The table still exists and the injection string is stored verbatim as a key.
    expect(await store.getChannelId(WECHAT, id)).toBe(inject);
    expect(keyRowCount(db, WECHAT, inject, 'thread')).toBe(1);
  });
});

describe('SqlitePlatformMappingStore reverse-lookup completeness (edge)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('getChannelId returns null for a syntactically valid but never-minted threadId', async () => {
    expect(await store.getChannelId(WECHAT, 'thread_wechat_000001700000099_cafef00d')).toBeNull();
  });

  it('getChannelId returns null on an empty db (no migration-time seed rows)', async () => {
    expect(await store.getChannelId(TELEGRAM, TELEGRAM_CHAT_ID)).toBeNull();
    expect(rowCount(db, TELEGRAM, 'thread')).toBe(0);
  });

  it('reverse lookup stays correct after many forward inserts (index integrity)', async () => {
    const minted = new Map<string, string>(); // channel → internal id
    for (let i = 0; i < 25; i += 1) {
      const channel = `-100${(1_000_000_000 + i).toString()}`;
      minted.set(channel, await store.resolveThread(TELEGRAM, channel));
    }
    // Every minted thread reverse-resolves to exactly its channel.
    for (const [channel, threadId] of minted) {
      expect(await store.getChannelId(TELEGRAM, threadId)).toBe(channel);
    }
  });
});
