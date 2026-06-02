// M8 QA — infrastructure edge + adversarial coverage (independently authored).
//
// Direct-unit attacks on the M8 building blocks the route tests exercise only
// indirectly:
//   - ThreadSequencer: strict per-thread ordering, fault isolation (a throwing
//     task does not break the chain), no cross-thread head-of-line blocking
//   - BroadcastRateMonitor: burst then throttle, time-based refill
//   - SqliteThreadStore: ensureThread idempotency, missing-id no-ops, persistence
//     across a fresh store instance on the same db handle
//   - buildApp inject seam: injected fake is actually used; overrides.db isolates

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { ThreadSequencer } from '@choco/api/infrastructure/thread-sequencer';
import { BroadcastRateMonitor } from '@choco/api/infrastructure/broadcast-rate-monitor';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { buildApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, replyScript } from './helpers.js';

describe('ThreadSequencer (edge/adversarial)', () => {
  it('runs tasks for one thread strictly in FIFO order despite varied async delays', async () => {
    const seq = new ThreadSequencer();
    const order: number[] = [];
    const delays = [40, 5, 25, 0, 15];
    const promises = delays.map((d, i) =>
      seq.enqueue('thread-order', async () => {
        await new Promise((r) => setTimeout(r, d));
        order.push(i);
      }),
    );
    await Promise.all(promises);
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('a throwing task does not break the chain — the next task still runs', async () => {
    const seq = new ThreadSequencer();
    const ran: string[] = [];
    const bad = seq.enqueue('thread-fault', () => {
      throw new Error('broadcast emit blew up');
    });
    const good = seq.enqueue('thread-fault', () => {
      ran.push('after-fault');
    });
    await expect(bad).rejects.toThrow('blew up');
    await good;
    expect(ran).toEqual(['after-fault']);
  });

  it('independent threads are not head-of-line blocked by a slow thread', async () => {
    const seq = new ThreadSequencer();
    const done: string[] = [];
    const slow = seq.enqueue('thread-slow', async () => {
      await new Promise((r) => setTimeout(r, 120));
      done.push('slow');
    });
    const fast = seq.enqueue('thread-fast', async () => {
      done.push('fast');
    });
    await fast;
    // The fast thread completed while the slow thread is still pending.
    expect(done).toEqual(['fast']);
    await slow;
    expect(done).toEqual(['fast', 'slow']);
  });
});

describe('BroadcastRateMonitor (edge)', () => {
  it('allows a burst up to capacity then throttles, and refills over time', () => {
    let clock = 1_000_000;
    const monitor = new BroadcastRateMonitor({
      burstCapacity: 5,
      refillPerSec: 10,
      now: () => clock,
    });
    const tid = 'thread-bucket';
    // Drain the burst budget.
    for (let i = 0; i < 5; i += 1) {
      expect(monitor.shouldBroadcast(tid)).toBe(true);
    }
    // 6th in the same instant is throttled.
    expect(monitor.shouldBroadcast(tid)).toBe(false);
    // After 200ms at 10 tokens/sec → 2 tokens refilled.
    clock += 200;
    expect(monitor.shouldBroadcast(tid)).toBe(true);
    expect(monitor.shouldBroadcast(tid)).toBe(true);
    expect(monitor.shouldBroadcast(tid)).toBe(false);
  });

  it('isolates buckets per thread (one thread draining does not throttle another)', () => {
    let clock = 0;
    const monitor = new BroadcastRateMonitor({ burstCapacity: 2, refillPerSec: 0, now: () => clock });
    expect(monitor.shouldBroadcast('thread-a')).toBe(true);
    expect(monitor.shouldBroadcast('thread-a')).toBe(true);
    expect(monitor.shouldBroadcast('thread-a')).toBe(false); // a is drained
    // b has its own fresh budget.
    expect(monitor.shouldBroadcast('thread-b')).toBe(true);
    clock += 1;
  });
});

describe('SqliteThreadStore (edge/adversarial)', () => {
  it('ensureThread is idempotent: calling twice yields one row and keeps the first title', async () => {
    const db = new Database(':memory:');
    const store = new SqliteThreadStore(db);
    const first = await store.ensureThread('thread-idem', '第一次的标题');
    const second = await store.ensureThread('thread-idem', '第二次的标题（应被忽略）');
    expect(second.id).toBe(first.id);
    expect(second.title).toBe('第一次的标题');
    const list = await store.list();
    expect(list.filter((t) => t.id === 'thread-idem')).toHaveLength(1);
    db.close();
  });

  it('get on an unknown id returns null; delete-then-get returns null', async () => {
    const db = new Database(':memory:');
    const store = new SqliteThreadStore(db);
    expect(await store.get('never-created')).toBeNull();
    const t = await store.create({ title: '临时线程' });
    expect(await store.get(t.id)).not.toBeNull();
    expect(await store.delete(t.id)).toBe(true);
    expect(await store.get(t.id)).toBeNull();
    // Deleting again is a clean false (no throw).
    expect(await store.delete(t.id)).toBe(false);
    db.close();
  });

  it('update* on a missing id is a silent no-op (no throw, no phantom row)', async () => {
    const db = new Database(':memory:');
    const store = new SqliteThreadStore(db);
    await store.updateLastActive('ghost');
    await store.updateTitle('ghost', '幽灵标题');
    await store.updateSopStage('ghost', 'quality_gate');
    await store.addParticipants('ghost', [createAgentId('claude-opus')]);
    expect(await store.get('ghost')).toBeNull();
    expect(await store.list()).toHaveLength(0);
    db.close();
  });

  it('threads persist across a fresh store instance on the same db handle (SQLite, not in-memory map)', async () => {
    const db = new Database(':memory:');
    const writer = new SqliteThreadStore(db);
    const created = await writer.create({ title: '持久化校验线程', thinkingMode: 'play' });
    await writer.addParticipants(created.id, [createAgentId('codex-gpt')]);

    // A brand-new store object over the SAME handle must see the persisted row.
    const reader = new SqliteThreadStore(db);
    const reloaded = await reader.get(created.id);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.title).toBe('持久化校验线程');
    expect(reloaded?.thinkingMode).toBe('play');
    expect(reloaded?.participants).toContain('codex-gpt');
    db.close();
  });
});

describe('buildApp inject seam (edge/adversarial)', () => {
  it('the injected fake provider is actually driven (not the real CLI provider)', async () => {
    const fake = new FakeAgentService([replyScript(CLAUDE, '来自注入 fake 的回复')]);
    const db = new Database(':memory:');
    const app = buildApp({ db, agentServices: { 'claude-opus': fake } });
    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-seam-edge/messages',
      payload: { content: '@claude 验证注入 seam' },
    });
    expect(fake.calls).toHaveLength(1);
    // The composed prompt carries the user's real content through the seam.
    expect(fake.calls[0]?.prompt).toContain('验证注入 seam');
    await app.close();
  });

  it('overrides.db isolates state: two apps on separate dbs do not share threads', async () => {
    const dbA = new Database(':memory:');
    const dbB = new Database(':memory:');
    const appA = buildApp({ db: dbA, agentServices: { 'claude-opus': new FakeAgentService([]) } });
    const appB = buildApp({ db: dbB, agentServices: { 'claude-opus': new FakeAgentService([]) } });

    await appA.api.inject({ method: 'POST', url: '/api/threads', payload: { title: '只属于 A 的线程' } });

    const listA = await appA.stores.threadStore.list();
    const listB = await appB.stores.threadStore.list();
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(0);

    await appA.close();
    await appB.close();
  });
});
