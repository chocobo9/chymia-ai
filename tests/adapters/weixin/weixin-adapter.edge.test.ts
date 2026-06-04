// tests/adapters/weixin/weixin-adapter.edge.test.ts — M14b long-poll adapter
// EDGE + ADVERSARIAL gate. Authored by the INDEPENDENT QA instance (dev≠QA, §0.5.3).
// The dev proved login→poll→reply end-to-end (weixin-wiring.test.ts); this file gates
// the adapter's LOOP semantics over a fake fetch: a reply with no cached context_token
// is a no-op (not a throw), a session-expired poll fires onSessionExpired exactly once
// and halts polling, start() is idempotent, an inbound dispatch error does NOT kill the
// loop, and stop() resolves. `sleep: async()=>{}` skips the real error backoff so the
// loop spins deterministically. NO product code modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, vi } from 'vitest';
import type { AgentId, IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  createWeixinAdapter,
  type FetchFn,
  type IngressResult,
  type SubmitPlatformMessage,
} from '@choco/adapters/weixin';

const CLAUDE: AgentId = createAgentId('claude-opus');

/** A 200 JSON Response. */
function jsonOk(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Build a minimal StoredMessage reply (the adapter only reads `content`). */
function reply(content: string): StoredMessage {
  return { id: `m-${content}`, threadId: 't1', userId: 'claude-opus', agentId: CLAUDE, content, mentions: [], timestamp: Date.now() };
}

/** A submit seam that records every inbound and returns the given replies. */
function recordingSubmit(replies: StoredMessage[]): {
  readonly submit: SubmitPlatformMessage;
  readonly inbound: IncomingPlatformMessage[];
} {
  const inbound: IncomingPlatformMessage[] = [];
  const submit: SubmitPlatformMessage = async (incoming) => {
    inbound.push(incoming);
    return { threadId: 't1', userId: 'u1', replies };
  };
  return { submit, inbound };
}

/** Spin the event loop until `cond` is true or `ms` elapses (no fake timers). */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error('waitFor timed out');
}

const NO_WAIT = async (): Promise<void> => {};

describe('WeixinAdapter.sendMessage — no cached context_token (adversarial)', () => {
  it('[adversarial] sendMessage to a chat with no cached context_token is a no-op (no throw, no fetch)', async () => {
    // Arrange — a fresh adapter has never seen an inbound from this chat, so it has no
    // reply token. Replying must warn + return, NOT throw and NOT hit sendmessage.
    const sendCalls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      sendCalls.push(String(input));
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const warn = vi.fn();
    const adapter = createWeixinAdapter({
      submitPlatformMessage: recordingSubmit([]).submit,
      botToken: 'ilbt_x',
      fetchFn,
      logger: { info: () => {}, warn, error: () => {} },
      sleep: NO_WAIT,
    });

    // Act + Assert — resolves without throwing.
    await expect(adapter.sendMessage('wxuser_unknown', '你好')).resolves.toBeUndefined();
    // No sendmessage POST happened.
    expect(sendCalls.filter((u) => u.includes('sendmessage'))).toHaveLength(0);
    // It warned about the missing token.
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('WeixinAdapter loop — session expiry (edge + adversarial)', () => {
  it('[edge] a sessionExpired (errcode -14) update calls onSessionExpired exactly once and stops polling', async () => {
    // Arrange — the first getupdates returns the -14 expiry sentinel.
    const onSessionExpired = vi.fn();
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('getupdates')) return jsonOk({ errcode: -14, errmsg: 'token expired' });
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const adapter = createWeixinAdapter({
      submitPlatformMessage: recordingSubmit([]).submit,
      botToken: 'ilbt_dead',
      fetchFn,
      onSessionExpired,
      sleep: NO_WAIT,
    });

    // Act
    adapter.start();
    await waitFor(() => onSessionExpired.mock.calls.length > 0);
    // Give the loop a moment to ensure it does not fire again.
    await new Promise((r) => setTimeout(r, 50));

    // Assert — fired once, polling halted.
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(adapter.isPolling).toBe(false);

    await adapter.stop();
  });
});

describe('WeixinAdapter.start — idempotency (edge)', () => {
  it('[edge] start() called twice does NOT launch a second poll loop (no duplicated getupdates storm)', async () => {
    // Arrange — count getupdates calls; a single loop issues them one-at-a-time. The
    // fake delays each empty poll so two concurrent loops would visibly double the rate.
    let getUpdatesInFlight = 0;
    let maxConcurrent = 0;
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes('getupdates')) {
        getUpdatesInFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, getUpdatesInFlight);
        await new Promise((r) => setTimeout(r, 30));
        getUpdatesInFlight -= 1;
        return jsonOk({ ret: 0, msgs: [] });
      }
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const adapter = createWeixinAdapter({
      submitPlatformMessage: recordingSubmit([]).submit,
      botToken: 'ilbt_idem',
      fetchFn,
      sleep: NO_WAIT,
    });

    // Act — double start, then let the loop run a few cycles.
    adapter.start();
    adapter.start();
    expect(adapter.isPolling).toBe(true);
    await new Promise((r) => setTimeout(r, 120));

    // Assert — never more than one getupdates in flight at a time (single loop).
    expect(maxConcurrent).toBe(1);

    await adapter.stop();
  });
});

describe('WeixinAdapter loop — inbound dispatch error resilience (adversarial)', () => {
  it('[adversarial] an inbound dispatch that throws does NOT kill the loop; later messages still flow', async () => {
    // Arrange — the FIRST submit throws (a pipeline blowup); the SECOND must still be
    // processed and replied to. The loop must survive the error and keep polling.
    const replies = [reply('第二条已处理')];
    let submitCalls = 0;
    const submit: SubmitPlatformMessage = async (_incoming): Promise<IngressResult> => {
      submitCalls += 1;
      if (submitCalls === 1) throw new Error('pipeline exploded on first message');
      return { threadId: 't1', userId: 'u1', replies };
    };
    const sends: Array<{ to: string; text: string }> = [];
    let getUpdatesCalls = 0;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getupdates')) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonOk({ ret: 0, get_updates_buf: 'c1', msgs: [{ from_user_id: 'wxuser_a', context_token: 'ctx_a', message_id: 'm1', item_list: [{ type: 1, text_item: { text: '第一条' } }] }] });
        }
        if (getUpdatesCalls === 2) {
          return jsonOk({ ret: 0, get_updates_buf: 'c2', msgs: [{ from_user_id: 'wxuser_b', context_token: 'ctx_b', message_id: 'm2', item_list: [{ type: 1, text_item: { text: '第二条' } }] }] });
        }
        await new Promise((r) => setTimeout(r, 30));
        return jsonOk({ ret: 0, get_updates_buf: 'c2', msgs: [] });
      }
      if (url.includes('sendmessage')) {
        const body = JSON.parse(String(init?.body)) as { msg: { to_user_id: string; item_list: Array<{ text_item: { text: string } }> } };
        sends.push({ to: body.msg.to_user_id, text: body.msg.item_list[0]!.text_item.text });
        return jsonOk({ ret: 0 });
      }
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const adapter = createWeixinAdapter({ submitPlatformMessage: submit, botToken: 'ilbt_resil', fetchFn, sleep: NO_WAIT });

    // Act
    adapter.start();
    await waitFor(() => sends.length > 0);

    // Assert — the loop survived the first throw and the second message got a reply.
    expect(submitCalls).toBeGreaterThanOrEqual(2);
    expect(sends[0]).toEqual({ to: 'wxuser_b', text: '第二条已处理' });
    expect(adapter.isPolling).toBe(true);

    await adapter.stop();
  });
});

describe('WeixinAdapter.stop — clean shutdown (edge)', () => {
  it('[edge] stop() resolves and leaves isPolling false (the loop has exited)', async () => {
    // Arrange — a long-poll that hangs until aborted (mirrors a real idle long-poll).
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getupdates')) {
        return await new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          const timer = setTimeout(() => resolve(jsonOk({ ret: 0, msgs: [] })), 5000);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const adapter = createWeixinAdapter({ submitPlatformMessage: recordingSubmit([]).submit, botToken: 'ilbt_stop', fetchFn, sleep: NO_WAIT });

    // Act
    adapter.start();
    expect(adapter.isPolling).toBe(true);
    await adapter.stop();

    // Assert
    expect(adapter.isPolling).toBe(false);
    // stop() is safe to call again (idempotent shutdown).
    await expect(adapter.stop()).resolves.toBeUndefined();
  });

  it('[edge] an empty reply (zero-length content) is NOT sent back (no empty messages leak to WeChat)', async () => {
    // Arrange — the agent yields one empty reply and one real reply; only the real one
    // should be sent.
    const replies = [reply(''), reply('真正的回复')];
    // reply('') has content '' — must be skipped.
    const { submit } = recordingSubmit(replies);
    const sends: string[] = [];
    let getUpdatesCalls = 0;
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getupdates')) {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          return jsonOk({ ret: 0, get_updates_buf: 'c1', msgs: [{ from_user_id: 'wxuser_e', context_token: 'ctx_e', message_id: 'm1', item_list: [{ type: 1, text_item: { text: '触发回复' } }] }] });
        }
        await new Promise((r) => setTimeout(r, 30));
        return jsonOk({ ret: 0, msgs: [] });
      }
      if (url.includes('sendmessage')) {
        const body = JSON.parse(String(init?.body)) as { msg: { item_list: Array<{ text_item: { text: string } }> } };
        sends.push(body.msg.item_list[0]!.text_item.text);
        return jsonOk({ ret: 0 });
      }
      return jsonOk({ ret: 0 });
    }) as FetchFn;
    const adapter = createWeixinAdapter({ submitPlatformMessage: submit, botToken: 'ilbt_empty', fetchFn, sleep: NO_WAIT });

    // Act
    adapter.start();
    await waitFor(() => sends.length > 0);
    await new Promise((r) => setTimeout(r, 40));

    // Assert — exactly the non-empty reply was sent.
    expect(sends).toEqual(['真正的回复']);

    await adapter.stop();
  });
});
