// tests/adapters/feishu/feishu-adapter.edge.test.ts — M-FEISHU 飞书 adapter
// EDGE + ADVERSARIAL gate (independent QA, dev≠QA §0.5.3).
//
// The dev shipped the LarkChannel adapter (handleMessage: ❤️ receipt → submit with
// onTextDelta → per-agent streaming card → non-streamed replies sent as markdown,
// all failure-isolated) plus a happy-path proof (feishu-adapter.test.ts). This file
// is the failure-isolation + multi-agent + reply-skip + reply-opts + lifecycle gate:
//   - adversarial: a throwing submit / send / stream / addReaction must be caught +
//     logged, never bubbled; the turn still resolves.
//   - edge: two agents → exactly two cards (neither re-sent); non-text inbound →
//     placeholder text reaches submit; an empty-content reply is skipped; group vs
//     p2p reply opts (incl. missing senderName); start() idempotent, stop() no-op,
//     channel error/reconnecting/reconnected flip isConnected.
//   - AsyncChunkQueue unit edges: push-after-close dropped, close-then-iterate
//     terminates, ordering preserved.
// NO product code modified (tests/ only). A product bug found here is reported, not fixed.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, vi } from 'vitest';
import type { AgentId, StoredMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type {
  NormalizedMessage,
  SendInput,
  SendOptions,
  StreamInput,
} from '@larksuiteoapi/node-sdk';
import {
  createFeishuAdapter,
  contentForIngress,
  AsyncChunkQueue,
  type SubmitPlatformMessage,
  type IngressResult,
  type LarkChannelLike,
  type AdapterLogger,
} from '@choco/adapters/feishu';

const CLAUDE: AgentId = createAgentId('claude-opus');
const GEMINI: AgentId = createAgentId('gemini-pro');

function storedReply(agentId: AgentId | null, content: string): StoredMessage {
  return {
    id: `msg-${String(agentId)}-${content}`,
    threadId: 't1',
    userId: 'u1',
    agentId,
    content,
    mentions: [],
    timestamp: 1,
  };
}

function baseMessage(over: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: 'om_msg_1',
    chatId: 'oc_chat_1',
    chatType: 'p2p',
    senderId: 'ou_user_1',
    content: '你好',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 1_700_000_000_000,
    ...over,
  };
}

/** A spy logger satisfying AdapterLogger — records every call for assertions. */
function spyLogger(): AdapterLogger & {
  errors: Array<{ ctx: Record<string, unknown>; msg: string }>;
  warns: Array<{ ctx: Record<string, unknown>; msg: string }>;
} {
  const errors: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
  const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
  return {
    errors,
    warns,
    info: () => {},
    warn: (ctx, msg) => {
      warns.push({ ctx, msg });
    },
    error: (ctx, msg) => {
      errors.push({ ctx, msg });
    },
  };
}

/** Knobs to make any channel surface throw / reject. */
interface ChannelFaults {
  readonly sendThrows?: boolean;
  readonly streamRejects?: boolean;
  readonly reactionThrows?: boolean;
}

/** Fake channel capturing stream/send/reaction calls + driving the markdown producer. */
function makeFakeChannel(faults: ChannelFaults = {}): {
  channel: LarkChannelLike;
  streamOpts: Array<SendOptions | undefined>;
  streamedCards: string[];
  sends: Array<{ to: string; input: SendInput; opts: SendOptions | undefined }>;
  reactedMessageIds: string[];
} {
  const streamOpts: Array<SendOptions | undefined> = [];
  const streamedCards: string[] = [];
  const sends: Array<{ to: string; input: SendInput; opts: SendOptions | undefined }> = [];
  const reactedMessageIds: string[] = [];
  const channel: LarkChannelLike = {
    connect: async () => {},
    disconnect: async () => {},
    on: (() => () => {}) as LarkChannelLike['on'],
    send: async (to, input, opts) => {
      if (faults.sendThrows === true) throw new Error('feishu send failed (rate limited)');
      sends.push({ to, input, opts });
      return { messageId: 'om_send' };
    },
    stream: async (_to, input: StreamInput, opts) => {
      streamOpts.push(opts);
      if (faults.streamRejects === true) {
        throw new Error('feishu stream open failed (card quota exceeded)');
      }
      if ('markdown' in input) {
        let acc = '';
        await input.markdown({
          messageId: 'om_stream',
          setContent: async (full: string) => {
            acc = full;
          },
          append: async (chunk: string) => {
            acc += chunk;
          },
        });
        streamedCards.push(acc);
      }
      return { messageId: 'om_stream' };
    },
    addReaction: async (messageId: string) => {
      if (faults.reactionThrows === true) throw new Error('feishu addReaction failed');
      reactedMessageIds.push(messageId);
      return 'reaction_1';
    },
    getConnectionStatus: () => ({ state: 'connected' }),
  };
  return { channel, streamOpts, streamedCards, sends, reactedMessageIds };
}

/** Build a started adapter over a given submit + channel (+ optional logger). */
async function startedAdapter(
  submit: SubmitPlatformMessage,
  channel: LarkChannelLike,
  logger?: AdapterLogger,
): Promise<ReturnType<typeof createFeishuAdapter>> {
  const adapter = createFeishuAdapter({
    submitPlatformMessage: submit,
    appId: 'cli_app',
    appSecret: 'sec',
    channelFactory: () => channel,
    ...(logger !== undefined ? { logger } : {}),
  });
  await adapter.start();
  return adapter;
}

/** A submit emitting one delta for `agent` then returning its reply (streams). */
function streamingSubmit(agent: AgentId, text: string): SubmitPlatformMessage {
  return async (_incoming, opts) => {
    opts?.onTextDelta?.(agent, text);
    return { threadId: 't1', userId: 'u1', replies: [storedReply(agent, text)] };
  };
}

// ───────────────────────────── ADVERSARIAL ─────────────────────────────

describe('FeishuAdapter.handleMessage — failure isolation (adversarial)', () => {
  it('[adversarial] a submit that THROWS is caught + logged; handleMessage resolves and does NOT throw', async () => {
    const logger = spyLogger();
    const { channel, streamedCards, sends } = makeFakeChannel();
    const throwingSubmit: SubmitPlatformMessage = async () => {
      throw new Error('ingress pipeline exploded (router down)');
    };
    const adapter = await startedAdapter(throwingSubmit, channel, logger);

    await expect(adapter.handleMessage(baseMessage({ content: '在吗' }))).resolves.toBeUndefined();

    // Nothing streamed/sent; the failure was logged on the dispatch path, not thrown.
    expect(streamedCards).toEqual([]);
    expect(sends).toEqual([]);
    expect(logger.errors.some((e) => e.msg === 'feishu inbound dispatch failed')).toBe(true);
    expect(logger.errors.some((e) => String(e.ctx.err).includes('router down'))).toBe(true);
  });

  it('[adversarial] a submit that throws AFTER opening a stream aborts the stream cleanly (no dangling promise, no rejection)', async () => {
    const logger = spyLogger();
    const { channel, streamedCards } = makeFakeChannel();
    // Emit a delta (opens the card) THEN throw — exercises StreamSet.abort() on the
    // error path: queues closed + stream promise awaited, no unhandled rejection.
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, '部分内容');
      throw new Error('submit failed mid-stream');
    };
    const adapter = await startedAdapter(submit, channel, logger);

    await expect(adapter.handleMessage(baseMessage({}))).resolves.toBeUndefined();

    // The card the delta opened still finalized (producer drained to close on abort).
    expect(streamedCards.some((c) => c.includes('部分内容'))).toBe(true);
    expect(logger.errors.some((e) => e.msg === 'feishu inbound dispatch failed')).toBe(true);
  });

  it('[adversarial] channel.send THROWS on a NON-streamed reply → caught + logged, no crash, the streamed reply still lands', async () => {
    const logger = spyLogger();
    const { channel, streamedCards, sends } = makeFakeChannel({ sendThrows: true });
    // Two replies: CLAUDE streams (delta fired), GEMINI produced NO delta → goes to
    // channel.send, which throws. The throw must be swallowed inside sendMarkdown.
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, '流式回复');
      return {
        threadId: 't1',
        userId: 'u1',
        replies: [storedReply(CLAUDE, '流式回复'), storedReply(GEMINI, '仅工具活动的回复')],
      };
    };
    const adapter = await startedAdapter(submit, channel, logger);

    await expect(adapter.handleMessage(baseMessage({}))).resolves.toBeUndefined();

    expect(streamedCards.some((c) => c.includes('流式回复'))).toBe(true);
    expect(sends).toEqual([]); // the throwing send recorded nothing
    expect(logger.errors.some((e) => e.msg === 'feishu send failed')).toBe(true);
    // The dispatch path itself did NOT fail — send failure is isolated below it.
    expect(logger.errors.some((e) => e.msg === 'feishu inbound dispatch failed')).toBe(false);
  });

  it('[adversarial] channel.stream REJECTS → caught by the StreamSet .catch + logged; handleMessage still resolves', async () => {
    const logger = spyLogger();
    const { channel, streamOpts } = makeFakeChannel({ streamRejects: true });
    const adapter = await startedAdapter(streamingSubmit(CLAUDE, '会失败的流'), channel, logger);

    await expect(adapter.handleMessage(baseMessage({}))).resolves.toBeUndefined();

    expect(streamOpts).toHaveLength(1); // it tried to open exactly one stream
    expect(logger.errors.some((e) => e.msg === 'feishu stream failed')).toBe(true);
    // The streaming agent counts as "did stream", so its reply is NOT also re-sent
    // even though the stream rejected (no duplicate fallback markdown).
    expect(logger.errors.some((e) => e.msg === 'feishu inbound dispatch failed')).toBe(false);
  });

  it('[adversarial] addReaction THROWS → non-fatal (warn only), the reply still streams', async () => {
    const logger = spyLogger();
    const { channel, streamedCards } = makeFakeChannel({ reactionThrows: true });
    const adapter = await startedAdapter(streamingSubmit(CLAUDE, '回执失败但仍回复'), channel, logger);

    await expect(adapter.handleMessage(baseMessage({}))).resolves.toBeUndefined();

    expect(streamedCards.some((c) => c.includes('回执失败但仍回复'))).toBe(true);
    expect(logger.warns.some((w) => w.msg === 'feishu receipt reaction failed')).toBe(true);
    expect(logger.errors).toEqual([]); // a missing receipt is warn-level, not error
  });
});

// ───────────────────────────── EDGE ─────────────────────────────

describe('FeishuAdapter.handleMessage — multi-agent + reply selection (edge)', () => {
  it('[edge] two agents each emit deltas → exactly TWO streaming cards (one per agent), neither re-sent', async () => {
    const { channel, streamedCards, sends } = makeFakeChannel();
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, 'Claude 的回答');
      opts?.onTextDelta?.(GEMINI, 'Gemini 的回答');
      return {
        threadId: 't1',
        userId: 'u1',
        replies: [storedReply(CLAUDE, 'Claude 的回答'), storedReply(GEMINI, 'Gemini 的回答')],
      };
    };
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(baseMessage({}));

    expect(streamedCards).toHaveLength(2);
    expect(streamedCards.some((c) => c.includes('Claude 的回答'))).toBe(true);
    expect(streamedCards.some((c) => c.includes('Gemini 的回答'))).toBe(true);
    expect(sends).toEqual([]); // both streamed → nothing re-sent as markdown
  });

  it('[edge] interleaved deltas for two agents still open exactly two cards and preserve each agent text', async () => {
    const { channel, streamedCards } = makeFakeChannel();
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, 'A1 ');
      opts?.onTextDelta?.(GEMINI, 'B1 ');
      opts?.onTextDelta?.(CLAUDE, 'A2');
      opts?.onTextDelta?.(GEMINI, 'B2');
      return {
        threadId: 't1',
        userId: 'u1',
        replies: [storedReply(CLAUDE, 'A1 A2'), storedReply(GEMINI, 'B1 B2')],
      };
    };
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(baseMessage({}));

    expect(streamedCards).toHaveLength(2);
    expect(streamedCards.some((c) => c.includes('A1 ') && c.includes('A2'))).toBe(true);
    expect(streamedCards.some((c) => c.includes('B1 ') && c.includes('B2'))).toBe(true);
  });

  it('[edge] a non-streamed reply (no delta for its agent) IS sent as markdown alongside the streamed card', async () => {
    const { channel, streamedCards, sends } = makeFakeChannel();
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, '流式');
      return {
        threadId: 't1',
        userId: 'u1',
        replies: [storedReply(CLAUDE, '流式'), storedReply(GEMINI, '系统通知，无增量')],
      };
    };
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(baseMessage({}));

    expect(streamedCards.some((c) => c.includes('流式'))).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.input).toEqual({ markdown: '系统通知，无增量' });
  });

  it('[edge] a reply with EMPTY content is skipped — not streamed, not sent', async () => {
    const { channel, streamedCards, sends } = makeFakeChannel();
    // CLAUDE streams a real reply; GEMINI returns an empty-content reply with no delta.
    const submit: SubmitPlatformMessage = async (_incoming, opts) => {
      opts?.onTextDelta?.(CLAUDE, '有内容');
      return {
        threadId: 't1',
        userId: 'u1',
        replies: [storedReply(CLAUDE, '有内容'), storedReply(GEMINI, '')],
      };
    };
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(baseMessage({}));

    expect(streamedCards.some((c) => c.includes('有内容'))).toBe(true);
    expect(sends).toEqual([]); // the empty reply is dropped (content.length === 0)
  });

  it('[edge] a reply whose agentId is null but has content IS sent as markdown (no stream to dedupe against)', async () => {
    const { channel, sends, streamedCards } = makeFakeChannel();
    // A system/notice reply (agentId null, never streams) with real content → sent.
    const submit: SubmitPlatformMessage = async () => ({
      threadId: 't1',
      userId: 'u1',
      replies: [storedReply(null, '⚠️ 你 @ 的 agent 不可用')] as StoredMessage[],
    });
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(baseMessage({}));

    expect(streamedCards).toEqual([]); // no delta → no card
    expect(sends).toHaveLength(1);
    expect(sends[0]?.input).toEqual({ markdown: '⚠️ 你 @ 的 agent 不可用' });
  });
});

describe('FeishuAdapter.handleMessage — reply opts: group vs p2p (edge)', () => {
  it('[edge] a GROUP reply with NO senderName → mentions still carries openId, no name key', async () => {
    const { channel, streamOpts } = makeFakeChannel();
    const adapter = await startedAdapter(streamingSubmit(CLAUDE, '群里回复'), channel);

    await adapter.handleMessage(
      baseMessage({ chatType: 'group', senderName: undefined, content: '@bot 看下' }),
    );

    expect(streamOpts).toHaveLength(1);
    const opts = streamOpts[0];
    expect(opts?.replyTo).toBe('om_msg_1');
    expect(opts?.mentions).toEqual([{ key: '', openId: 'ou_user_1' }]);
    // No `name` property when senderName is absent (immutable conditional spread).
    expect(opts?.mentions?.[0]).not.toHaveProperty('name');
  });

  it('[edge] a p2p reply has undefined opts (no replyTo, no mentions)', async () => {
    const { channel, streamOpts } = makeFakeChannel();
    const adapter = await startedAdapter(streamingSubmit(CLAUDE, '私聊回复'), channel);

    await adapter.handleMessage(baseMessage({ chatType: 'p2p' }));

    expect(streamOpts).toEqual([undefined]);
  });

  it('[edge] a non-streamed GROUP reply is SENT with the same replyTo + @sender opts', async () => {
    const { channel, sends } = makeFakeChannel();
    const submit: SubmitPlatformMessage = async () => ({
      threadId: 't1',
      userId: 'u1',
      replies: [storedReply(GEMINI, '群里的系统通知')],
    });
    const adapter = await startedAdapter(submit, channel);

    await adapter.handleMessage(
      baseMessage({ chatType: 'group', senderName: '阿白', content: '@bot' }),
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]?.opts).toMatchObject({
      replyTo: 'om_msg_1',
      mentions: [{ openId: 'ou_user_1', name: '阿白' }],
    });
  });
});

describe('contentForIngress — non-text inbound becomes a placeholder that reaches submit (edge)', () => {
  it('[edge] file WITHOUT a fileName falls back to the bare [文件] placeholder', () => {
    expect(
      contentForIngress(baseMessage({ content: '', resources: [{ type: 'file', fileKey: 'f_k' }] })),
    ).toBe('[文件]');
  });

  it('[edge] video / sticker resources map to their typed placeholders', () => {
    expect(
      contentForIngress(baseMessage({ content: '', resources: [{ type: 'video', fileKey: 'v_k' }] })),
    ).toBe('[视频]');
    expect(
      contentForIngress(
        baseMessage({ content: '', resources: [{ type: 'sticker', fileKey: 's_k' }] }),
      ),
    ).toBe('[表情]');
  });

  it('[edge] empty content AND no resources → stays empty (nothing to surface)', () => {
    expect(contentForIngress(baseMessage({ content: '', resources: [] }))).toBe('');
  });

  it('[edge] real text wins even when a resource is also attached', () => {
    expect(
      contentForIngress(
        baseMessage({ content: '看这张图', resources: [{ type: 'image', fileKey: 'i_k' }] }),
      ),
    ).toBe('看这张图');
  });

  it('[edge] the placeholder text is what actually reaches submit (image / file / audio)', async () => {
    const seen: string[] = [];
    const capturingSubmit: SubmitPlatformMessage = async (incoming): Promise<IngressResult> => {
      seen.push(incoming.text);
      return { threadId: 't1', userId: 'u1', replies: [] };
    };
    const { channel } = makeFakeChannel();
    const adapter = await startedAdapter(capturingSubmit, channel);

    await adapter.handleMessage(
      baseMessage({ content: '', resources: [{ type: 'image', fileKey: 'img' }] }),
    );
    await adapter.handleMessage(
      baseMessage({ content: '', resources: [{ type: 'file', fileKey: 'f', fileName: '季度报告.xlsx' }] }),
    );
    await adapter.handleMessage(
      baseMessage({ content: '', resources: [{ type: 'audio', fileKey: 'a' }] }),
    );

    expect(seen).toEqual(['[图片]', '[文件] 季度报告.xlsx', '[语音]']);
  });
});

describe('FeishuAdapter lifecycle — start/stop/connection state (edge)', () => {
  it('[edge] start() twice builds the channel only ONCE (idempotent), stays connected', async () => {
    let built = 0;
    const { channel } = makeFakeChannel();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmit(CLAUDE, 'x'),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => {
        built += 1;
        return channel;
      },
    });

    await adapter.start();
    await adapter.start();

    expect(built).toBe(1);
    expect(adapter.isConnected).toBe(true);
  });

  it('[edge] stop() WITHOUT a prior start() is a safe no-op (resolves, stays disconnected)', async () => {
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmit(CLAUDE, 'x'),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => makeFakeChannel().channel,
    });

    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(adapter.isConnected).toBe(false);
  });

  it('[edge] handleMessage BEFORE start() is a no-op (channel null → returns, submit never called)', async () => {
    const submit = vi.fn(streamingSubmit(CLAUDE, 'x'));
    const adapter = createFeishuAdapter({
      submitPlatformMessage: submit,
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => makeFakeChannel().channel,
    });

    await expect(adapter.handleMessage(baseMessage({}))).resolves.toBeUndefined();
    expect(submit).not.toHaveBeenCalled();
  });

  it('[edge] handleMessage AFTER stop() is a no-op (channel cleared → submit never called)', async () => {
    const submit = vi.fn(streamingSubmit(CLAUDE, 'x'));
    const { channel } = makeFakeChannel();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: submit,
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => channel,
    });
    await adapter.start();
    await adapter.stop();

    await adapter.handleMessage(baseMessage({}));
    expect(submit).not.toHaveBeenCalled();
    expect(adapter.isConnected).toBe(false);
  });

  it("[edge] channel 'error' / 'reconnecting' flip isConnected false; 'reconnected' flips it true", async () => {
    // Capture the handlers the adapter registers so we can drive the lifecycle events.
    const handlers = new Map<string, (arg: unknown) => void>();
    const { channel } = makeFakeChannel();
    const onCapturing: LarkChannelLike['on'] = ((
      name: string,
      handler: (arg: unknown) => void,
    ) => {
      handlers.set(name, handler);
      return () => {};
    }) as LarkChannelLike['on'];
    const wired: LarkChannelLike = { ...channel, on: onCapturing };

    const logger = spyLogger();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmit(CLAUDE, 'x'),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => wired,
      logger,
    });
    await adapter.start();
    expect(adapter.isConnected).toBe(true);

    handlers.get('error')?.(new Error('socket dropped'));
    expect(adapter.isConnected).toBe(false);
    expect(logger.errors.some((e) => e.msg === 'feishu channel error')).toBe(true);

    handlers.get('reconnected')?.(undefined);
    expect(adapter.isConnected).toBe(true);

    handlers.get('reconnecting')?.(undefined);
    expect(adapter.isConnected).toBe(false);
    expect(logger.warns.some((w) => w.msg === 'feishu channel reconnecting')).toBe(true);

    handlers.get('reconnected')?.(undefined);
    expect(adapter.isConnected).toBe(true);
  });
});

// ───────────────────────── AsyncChunkQueue unit ─────────────────────────

describe('AsyncChunkQueue — push/pull bridge invariants (edge + adversarial)', () => {
  async function drain(queue: AsyncChunkQueue): Promise<string[]> {
    const out: string[] = [];
    for await (const chunk of queue) out.push(chunk);
    return out;
  }

  it('[edge] preserves push order across the async iterator', async () => {
    const q = new AsyncChunkQueue();
    q.push('一');
    q.push('二');
    q.push('三');
    q.close();
    expect(await drain(q)).toEqual(['一', '二', '三']);
  });

  it('[adversarial] a push AFTER close is dropped (not yielded, no throw)', async () => {
    const q = new AsyncChunkQueue();
    q.push('保留');
    q.close();
    q.push('迟到的增量'); // must be silently ignored
    expect(await drain(q)).toEqual(['保留']);
  });

  it('[edge] close BEFORE any push → iteration terminates immediately with no items', async () => {
    const q = new AsyncChunkQueue();
    q.close();
    expect(await drain(q)).toEqual([]);
  });

  it('[edge] close() is idempotent — a second close does not throw or change the drained output', async () => {
    const q = new AsyncChunkQueue();
    q.push('内容');
    q.close();
    q.close();
    expect(await drain(q)).toEqual(['内容']);
  });

  it('[adversarial] a consumer blocked on an empty queue is woken by a later push, then by close', async () => {
    const q = new AsyncChunkQueue();
    const drained = drain(q); // starts iterating; buffer empty → suspends
    // Hand control back to the event loop so the iterator parks on the empty buffer.
    await Promise.resolve();
    q.push('唤醒一');
    await Promise.resolve();
    q.push('唤醒二');
    q.close();
    expect(await drained).toEqual(['唤醒一', '唤醒二']);
  });
});
