// G4 dev happy-path suite (unit). QA owns edge + adversarial coverage.
//
// Fresh in-memory database per test for hermetic isolation. A monotonic fake
// clock makes created_at ordering deterministic. Real platform-shaped ids
// (WeChat OpenID-style + Telegram numeric chat ids), no placeholder data.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqlitePlatformMappingStore } from '@clowder/api/stores/platform-mapping-store';

/** Monotonic clock: each call returns a strictly increasing epoch-ms value. */
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

describe('SqlitePlatformMappingStore (unit, happy path)', () => {
  let db: Database.Database;
  let store: SqlitePlatformMappingStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqlitePlatformMappingStore(db, { now: makeClock() });
  });

  it('resolveThread mints a stable internal threadId (find-or-create)', async () => {
    const first = await store.resolveThread(WECHAT, WECHAT_CHANNEL);
    const second = await store.resolveThread(WECHAT, WECHAT_CHANNEL);

    expect(first).toMatch(/^thread_wechat_/);
    expect(second).toBe(first); // same platform channel → same internal thread
  });

  it('resolveUser mints a stable internal userId (find-or-create)', async () => {
    const first = await store.resolveUser(TELEGRAM, TELEGRAM_USER_ID);
    const second = await store.resolveUser(TELEGRAM, TELEGRAM_USER_ID);

    expect(first).toMatch(/^user_telegram_/);
    expect(second).toBe(first);
  });

  it('keeps thread and user mappings in separate namespaces', async () => {
    // Same platform_id used as both a channel and a user id must not collide,
    // because the composite PK includes `type`.
    const asThread = await store.resolveThread(WECHAT, WECHAT_OPENID);
    const asUser = await store.resolveUser(WECHAT, WECHAT_OPENID);

    expect(asThread).not.toBe(asUser);
    expect(asThread).toMatch(/^thread_/);
    expect(asUser).toMatch(/^user_/);
  });

  it('isolates mappings across adapters', async () => {
    const wechatThread = await store.resolveThread(WECHAT, WECHAT_CHANNEL);
    const telegramThread = await store.resolveThread(TELEGRAM, TELEGRAM_CHAT_ID);

    expect(wechatThread).not.toBe(telegramThread);
  });

  it('getChannelId reverse-resolves an internal threadId to its platform channel', async () => {
    const threadId = await store.resolveThread(WECHAT, WECHAT_CHANNEL);

    const channel = await store.getChannelId(WECHAT, threadId);

    expect(channel).toBe(WECHAT_CHANNEL);
  });

  it('getChannelId returns null for an unmapped threadId', async () => {
    const channel = await store.getChannelId(WECHAT, 'thread_never_mapped');

    expect(channel).toBeNull();
  });

  it('persists mappings so a second store over the same db sees them', async () => {
    const threadId = await store.resolveThread(TELEGRAM, TELEGRAM_CHAT_ID);

    // A fresh store instance over the SAME db (idempotent migration) re-reads it.
    const reopened = new SqlitePlatformMappingStore(db, { now: makeClock() });
    const sameThread = await reopened.resolveThread(TELEGRAM, TELEGRAM_CHAT_ID);
    const channel = await reopened.getChannelId(TELEGRAM, threadId);

    expect(sameThread).toBe(threadId);
    expect(channel).toBe(TELEGRAM_CHAT_ID);
  });
});
