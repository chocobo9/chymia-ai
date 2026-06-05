// tests/adapters/feishu/feishu-adapter.test.ts — M-FEISHU 飞书 adapter dev happy-path.
//
// Pure-unit happy coverage of the LarkChannel adapter's inbound core WITHOUT a
// socket: a fake `submitPlatformMessage` drives the reply set + onTextDelta, and a
// fake LarkChannelLike captures stream/send/reaction calls + their opts. Asserts:
// (1) non-text inbound → placeholder text; (2) pickReceiptLine determinism;
// (3) a group reply streams with replyTo + @sender mentions; (4) p2p reply has no opts.
//
// Edge/adversarial (throwing submit/send, empty replies, multi-agent, reconnect,
// onTextDelta backward-compat) → independent QA (dev≠QA §0.5.3).

import { describe, it, expect } from 'vitest';
import type { AgentId, StoredMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { NormalizedMessage, SendInput, SendOptions, StreamInput } from '@larksuiteoapi/node-sdk';
import {
  createFeishuAdapter,
  contentForIngress,
  pickReceiptLine,
  FEISHU_RECEIPT_LINES,
  type SubmitPlatformMessage,
  type LarkChannelLike,
} from '@choco/adapters/feishu';

const CLAUDE: AgentId = createAgentId('claude-opus');

function storedReply(agentId: AgentId, content: string): StoredMessage {
  return {
    id: `msg-${content}`,
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

/** Fake channel capturing stream/send opts + driving the markdown producer. */
function makeFakeChannel(): {
  channel: LarkChannelLike;
  streamOpts: Array<SendOptions | undefined>;
  streamedCards: string[];
  sends: Array<{ input: SendInput; opts: SendOptions | undefined }>;
} {
  const streamOpts: Array<SendOptions | undefined> = [];
  const streamedCards: string[] = [];
  const sends: Array<{ input: SendInput; opts: SendOptions | undefined }> = [];
  const channel: LarkChannelLike = {
    connect: async () => {},
    disconnect: async () => {},
    on: (() => () => {}) as LarkChannelLike['on'],
    send: async (_to, input, opts) => {
      sends.push({ input, opts });
      return { messageId: 'om_send' };
    },
    stream: async (_to, input: StreamInput, opts) => {
      streamOpts.push(opts);
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
    addReaction: async () => 'reaction_1',
    getConnectionStatus: () => ({ state: 'connected' }),
  };
  return { channel, streamOpts, streamedCards, sends };
}

/** A submit seam that emits one text delta for `agent` then returns its reply. */
function streamingSubmit(agent: AgentId, text: string): SubmitPlatformMessage {
  return async (_incoming, opts) => {
    opts?.onTextDelta?.(agent, text);
    return { threadId: 't1', userId: 'u1', replies: [storedReply(agent, text)] };
  };
}

describe('contentForIngress — non-text inbound becomes a placeholder, never silently dropped (happy)', () => {
  it('keeps real text content as-is', () => {
    expect(contentForIngress(baseMessage({ content: '真实文本' }))).toBe('真实文本');
  });

  it('maps an empty-content image/file/audio message to a typed placeholder', () => {
    expect(
      contentForIngress(baseMessage({ content: '', resources: [{ type: 'image', fileKey: 'img_k' }] })),
    ).toBe('[图片]');
    expect(
      contentForIngress(
        baseMessage({ content: '', resources: [{ type: 'file', fileKey: 'f_k', fileName: '报告.pdf' }] }),
      ),
    ).toBe('[文件] 报告.pdf');
    expect(
      contentForIngress(baseMessage({ content: '', resources: [{ type: 'audio', fileKey: 'a_k' }] })),
    ).toBe('[语音]');
  });
});

describe('pickReceiptLine — deterministic, in-bounds, real content (happy)', () => {
  it('returns a real non-empty line from the corpus for the same seed', () => {
    const line = pickReceiptLine(1_700_000_000_000);
    expect(FEISHU_RECEIPT_LINES).toContain(line);
    expect(line.length).toBeGreaterThan(0);
    // Deterministic for a fixed seed (no Math.random).
    expect(pickReceiptLine(1_700_000_000_000)).toBe(line);
  });
});

describe('FeishuAdapter.handleMessage — streams the reply with the right reply opts (happy)', () => {
  it('a GROUP reply streams with replyTo + an @-mention of the sender', async () => {
    const { channel, streamOpts, streamedCards } = makeFakeChannel();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmit(CLAUDE, '群里回复你'),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => channel,
    });
    await adapter.start();
    await adapter.handleMessage(
      baseMessage({ chatType: 'group', senderName: '阿黑', content: '@bot 看下' }),
    );

    expect(streamedCards.some((c) => c.includes('群里回复你'))).toBe(true);
    expect(streamOpts).toHaveLength(1);
    expect(streamOpts[0]).toMatchObject({
      replyTo: 'om_msg_1',
      mentions: [{ openId: 'ou_user_1', name: '阿黑' }],
    });
  });

  it('a p2p (DM) reply streams with NO reply opts', async () => {
    const { channel, streamOpts, streamedCards } = makeFakeChannel();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmit(CLAUDE, '私聊回复'),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => channel,
    });
    await adapter.start();
    await adapter.handleMessage(baseMessage({ chatType: 'p2p', content: '在吗' }));

    expect(streamedCards.some((c) => c.includes('私聊回复'))).toBe(true);
    expect(streamOpts).toEqual([undefined]);
  });
});

/** A submit that streams MULTIPLE deltas for one agent (token-by-token). */
function streamingSubmitMulti(agent: AgentId, chunks: readonly string[]): SubmitPlatformMessage {
  return async (_incoming, opts) => {
    for (const c of chunks) opts?.onTextDelta?.(agent, c);
    return { threadId: 't1', userId: 'u1', replies: [storedReply(agent, chunks.join(''))] };
  };
}

describe('FeishuAdapter.handleMessage — receipt placeholder is REPLACED, never glued (regression)', () => {
  it('the first real delta replaces the 收到… receipt; the final card is the pure reply', async () => {
    const { channel, streamedCards } = makeFakeChannel();
    const adapter = createFeishuAdapter({
      submitPlatformMessage: streamingSubmitMulti(CLAUDE, ['你好', '，', '世界']),
      appId: 'cli_app',
      appSecret: 'sec',
      channelFactory: () => channel,
    });
    await adapter.start();
    await adapter.handleMessage(baseMessage({ content: '在吗' }));

    // Final card content is exactly the joined reply — the receipt line was
    // setContent-replaced by the first delta, NOT appended in front of it.
    expect(streamedCards).toEqual(['你好，世界']);
    // And no receipt line survives as a prefix (the "打印处理行" bug).
    expect(FEISHU_RECEIPT_LINES.some((r) => streamedCards[0]?.startsWith(r))).toBe(false);
  });
});
