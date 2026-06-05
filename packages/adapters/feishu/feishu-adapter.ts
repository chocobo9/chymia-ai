// packages/adapters/feishu/feishu-adapter.ts
// Feishu (飞书/Lark) adapter — built on the SDK's HIGH-LEVEL LarkChannel layer
// (@larksuiteoapi/node-sdk), NOT the raw WSClient + hand-rolled parse/send/token.
//
// LarkChannel owns: WebSocket 长连接（无需公网回调 URL，只要 app 开启长连接事件
// 订阅）、token、入站归一化（群聊 + 发送者身份 + @bot 检测 + 非文本 resources）、
// 出站 send/stream/addReaction、去重、白名单、自动重连。我们只做编排：
// connect → on('message') → 映射 NormalizedMessage 为 IncomingPlatformMessage →
// 走 ingress seam（submit）→ 把回复发回同一会话（群聊 @回发送者 + replyTo）。
//
// 入站核心 handleMessage 不需要真 socket：QA 注入一个 LarkChannelLike fake（见
// channelFactory）即可驱动整条入站→回复链，与 Clowder 参考一致但从接口定义重写。

import { createLarkChannel } from '@larksuiteoapi/node-sdk';
import type {
  LarkChannelOptions,
  NormalizedMessage,
  SendInput,
  SendOptions,
  SendResult,
  StreamInput,
} from '@larksuiteoapi/node-sdk';
import type { AgentId, IncomingPlatformMessage, StoredMessage } from '@choco/shared';
import { AsyncChunkQueue } from './async-chunk-queue.js';
import { pickReceiptLine } from './feishu-receipt-lines.js';

const ADAPTER_NAME = 'feishu';

/**
 * Legacy injectable-fetch type. LarkChannel now owns all HTTP, so the adapter no
 * longer USES a fetch — but {@link FeishuManager} (lifecycle owner, out of this
 * plan's scope) still declares a `fetchFn?: FetchFn` dep + passes it through. The
 * type is kept exported so the manager compiles UNCHANGED; the adapter accepts it
 * as `unknown` and ignores it.
 */
export type FetchFn = typeof globalThis.fetch;

// 群聊只在被 @ 时响应，DM 总是响应 — LarkChannel policy 默认（带来源注释，
// 不加配置字段、不动 UI，per plan「群白名单/DM 配对留后」）。
const POLICY_REQUIRE_MENTION = true; // group: 仅当 @bot 时进入 on('message')
const POLICY_DM_MODE = 'open' as const; // p2p: 任何私聊都响应

// L1 即时回执的 emoji（飞书 reaction emoji_type 枚举之一）。
const RECEIPT_EMOJI = 'Heart'; // ❤️ — 收到即贴，fire-and-forget

/**
 * Open-platform region → long-connection gateway domain. A wrong choice fails the
 * WS handshake with Feishu error `1000040351 Incorrect domain name` (at
 * pullConnectConfig). 'feishu' = 飞书 China; 'lark' = Lark International.
 */
export type FeishuDomain = 'feishu' | 'lark';
const DOMAIN_URL: Record<FeishuDomain, string> = {
  feishu: 'https://open.feishu.cn', // 飞书 China — SDK default
  lark: 'https://open.larksuite.com', // Lark International
};

// Bound the WS handshake so a wrong domain / blocked egress REJECTS (visible in
// the log) instead of hanging connect() forever (SDK default: no timeout).
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Result of the platform-ingress seam (mirrors app-factory PlatformIngressResult). */
export interface IngressResult {
  readonly threadId: string;
  readonly userId: string;
  readonly replies: StoredMessage[];
}

/**
 * The ingress seam an adapter drives for one inbound message. The optional 2nd
 * arg (Phase 2) lets the adapter receive per-agent text deltas as they stream,
 * to drive a 飞书 streaming card. Callers passing no `opts` behave as before
 * (HTTP route + other adapters are unaffected — pure increment).
 */
export type SubmitPlatformMessage = (
  incoming: IncomingPlatformMessage,
  opts?: { readonly onTextDelta?: (agentId: AgentId, text: string) => void },
) => Promise<IngressResult>;

/** Structured logger seam (no console.log per project rules). */
export interface AdapterLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: AdapterLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * The subset of LarkChannel this adapter uses — declared so a test can inject a
 * fully-typed fake channel WITHOUT opening a real socket (mirrors the manager's
 * adapterFactory DI). A real LarkChannel satisfies this structurally.
 */
export interface LarkChannelLike {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(name: 'message', handler: (msg: NormalizedMessage) => void | Promise<void>): () => void;
  on(name: 'error' | 'reconnecting' | 'reconnected', handler: (arg: unknown) => void): () => void;
  send(to: string, input: SendInput, opts?: SendOptions): Promise<SendResult>;
  stream(to: string, input: StreamInput, opts?: SendOptions): Promise<SendResult>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  getConnectionStatus(): { state: string } | undefined;
}

/** Factory the adapter uses to build its channel (default = real createLarkChannel). */
export type ChannelFactory = (opts: LarkChannelOptions) => LarkChannelLike;

export interface FeishuAdapterDeps {
  readonly submitPlatformMessage: SubmitPlatformMessage;
  readonly appId: string;
  readonly appSecret: string;
  /** Region/gateway domain. Default 'feishu' (China). 'lark' for International. */
  readonly domain?: FeishuDomain;
  /**
   * Legacy DI no longer used — LarkChannel owns all HTTP (token/send). Kept
   * ACCEPTED so {@link FeishuManager} compiles unchanged while it still passes
   * `fetchFn`. Intentionally unread here.
   */
  readonly fetchFn?: unknown;
  /** Injectable channel factory (QA injects a fake LarkChannel; default = real). */
  readonly channelFactory?: ChannelFactory;
  readonly logger?: AdapterLogger;
}

/** Default factory: the real high-level LarkChannel. */
const DEFAULT_CHANNEL_FACTORY: ChannelFactory = (opts) => createLarkChannel(opts);

/** Feishu adapter over LarkChannel. Construct via {@link createFeishuAdapter}. */
export class FeishuAdapter {
  readonly name = ADAPTER_NAME;
  private readonly submit: SubmitPlatformMessage;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly domain: FeishuDomain;
  private readonly channelFactory: ChannelFactory;
  private readonly logger: AdapterLogger;
  private channel: LarkChannelLike | null = null;
  private connected = false;

  constructor(deps: FeishuAdapterDeps) {
    this.submit = deps.submitPlatformMessage;
    this.appId = deps.appId;
    this.appSecret = deps.appSecret;
    this.domain = deps.domain ?? 'feishu';
    this.channelFactory = deps.channelFactory ?? DEFAULT_CHANNEL_FACTORY;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Open the long connection and route normalized messages to handleMessage. */
  async start(): Promise<void> {
    if (this.channel !== null) return;
    const channel = this.channelFactory({
      appId: this.appId,
      appSecret: this.appSecret,
      transport: 'websocket',
      domain: DOMAIN_URL[this.domain], // 飞书 China / Lark International gateway
      handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS, // reject (not hang) on a bad domain/egress
      policy: { requireMention: POLICY_REQUIRE_MENTION, dmMode: POLICY_DM_MODE },
      safety: { dedup: {} }, // 入站去重默认开（LarkChannel 内建）
      outbound: { ssrfGuard: true }, // 出站媒体 SSRF 防护默认开
    });
    channel.on('message', (m: NormalizedMessage) => {
      // handleMessage 自带 try/catch，绝不让一条消息的失败冒泡到 SDK 事件循环。
      void this.handleMessage(m);
    });
    channel.on('error', (err: unknown) => {
      this.connected = false;
      this.logger.error({ err: String(err) }, 'feishu channel error');
    });
    channel.on('reconnecting', () => {
      this.connected = false;
      this.logger.warn({}, 'feishu channel reconnecting');
    });
    channel.on('reconnected', () => {
      this.connected = true;
      this.logger.info({}, 'feishu channel reconnected');
    });
    await channel.connect();
    this.channel = channel;
    this.connected = true;
  }

  /** Close the long connection. */
  async stop(): Promise<void> {
    const channel = this.channel;
    this.channel = null;
    this.connected = false;
    if (channel !== null) await channel.disconnect();
  }

  /**
   * Inbound core (testable WITHOUT a socket): map a NormalizedMessage → ingress
   * seam → reply. L1 instant receipt is a ❤️ reaction; agent text streams into a
   * 飞书 card (the AUTHORITATIVE reply — not also re-sent); replies that produced
   * NO text delta (system notices / tool-only agents) are sent as markdown.
   */
  async handleMessage(m: NormalizedMessage): Promise<void> {
    const channel = this.channel;
    if (channel === null) return;
    const incoming: IncomingPlatformMessage = {
      adapterName: ADAPTER_NAME,
      channelId: m.chatId,
      platformUserId: m.senderId,
      platformMessageId: m.messageId,
      text: contentForIngress(m),
      receivedAt: m.createTime,
    };

    // L1: 即时 ❤️ 回执（fire-and-forget；失败仅 log，绝不影响后续）。
    await this.react(channel, m.messageId);

    const opts = replyOptions(m);
    const streams = new StreamSet(channel, m, this.logger);
    try {
      const { replies } = await this.submit(incoming, {
        onTextDelta: (agentId, text) => streams.onDelta(agentId, text),
      });
      // 流式 agent 的卡片即权威回复；仅把「未产生文本增量」的回复（系统通知/仅
      // tool 活动的 agent）作为 markdown 发出，避免与卡片重复。
      await streams.finish();
      for (const reply of replies) {
        if (reply.content.length === 0) continue;
        if (reply.agentId !== null && streams.didStream(reply.agentId)) continue;
        await this.sendMarkdown(channel, m.chatId, reply.content, opts);
      }
    } catch (err) {
      await streams.abort();
      this.logger.error({ err: String(err), chatId: m.chatId }, 'feishu inbound dispatch failed');
    }
  }

  /** Send one markdown reply, isolating send failures (log, never throw). */
  private async sendMarkdown(
    channel: LarkChannelLike,
    chatId: string,
    content: string,
    opts: SendOptions | undefined,
  ): Promise<void> {
    try {
      await channel.send(chatId, { markdown: content }, opts);
    } catch (err) {
      this.logger.error({ err: String(err), chatId }, 'feishu send failed');
    }
  }

  /** Fire the ❤️ receipt reaction, swallowing failures (a missing receipt must not break the turn). */
  private async react(channel: LarkChannelLike, messageId: string): Promise<void> {
    try {
      await channel.addReaction(messageId, RECEIPT_EMOJI);
    } catch (err) {
      this.logger.warn({ err: String(err), messageId }, 'feishu receipt reaction failed');
    }
  }
}

/**
 * Per-turn streaming controller: lazily opens ONE 飞书 streaming card per agent on
 * its first text delta, bridging the push-style onTextDelta into LarkChannel's
 * pull-style MarkdownStreamProducer via an {@link AsyncChunkQueue}. `finish()`
 * closes every queue and awaits every stream so the cards finalize before the
 * caller sends the non-streamed replies.
 */
class StreamSet {
  private readonly queues = new Map<AgentId, AsyncChunkQueue>();
  private readonly streamPromises = new Map<AgentId, Promise<unknown>>();
  private readonly receiptSeed: number;
  private readonly opts: SendOptions | undefined;
  private readonly chatId: string;

  constructor(
    private readonly channel: LarkChannelLike,
    message: NormalizedMessage,
    private readonly logger: AdapterLogger,
  ) {
    this.receiptSeed = message.createTime;
    this.opts = replyOptions(message);
    this.chatId = message.chatId;
  }

  /** Whether a given agent produced streamed output (so the caller skips re-sending it). */
  didStream(agentId: AgentId): boolean {
    return this.queues.has(agentId);
  }

  /** Route one text delta into its agent's queue, opening the stream on first delta. */
  onDelta(agentId: AgentId, text: string): void {
    const existing = this.queues.get(agentId);
    if (existing !== undefined) {
      existing.push(text);
      return;
    }
    // 首个增量到达：开流。`queue` 用 const 绑定，使其在 producer 闭包内确定非 undefined。
    const queue = new AsyncChunkQueue();
    this.queues.set(agentId, queue);
    // initial 首行用一条中性回执，填补"思考中"的空窗，让卡片立刻有可见内容。
    // 关键：首个真实增量到达时用 setContent REPLACE 掉回执（而非 append），否则
    // 回执会被永久拼在回复前面（"了解，处理中…<回复>"），看起来像每条都在打印
    // 处理行。回执只在首 token 前短暂可见，之后即为纯回复正文。
    const initialText = pickReceiptLine(this.receiptSeed);
    const input: StreamInput = {
      markdown: async (ctrl) => {
        await ctrl.setContent(initialText);
        let receiptShown = true;
        for await (const chunk of queue) {
          if (receiptShown) {
            await ctrl.setContent(chunk); // 替换掉回执占位
            receiptShown = false;
          } else {
            await ctrl.append(chunk);
          }
        }
      },
    };
    const promise = this.channel.stream(this.chatId, input, this.opts).catch((err: unknown) => {
      this.logger.error({ err: String(err), chatId: this.chatId }, 'feishu stream failed');
    });
    this.streamPromises.set(agentId, promise);
    queue.push(text);
  }

  /** Close all queues and await all stream promises so the cards finalize. */
  async finish(): Promise<void> {
    for (const queue of this.queues.values()) queue.close();
    await Promise.all(this.streamPromises.values());
  }

  /** Close + await on the error path so no stream promise is left dangling. */
  async abort(): Promise<void> {
    await this.finish();
  }
}

/**
 * Build the ingress `text` from a normalized message. Non-text inbound (no/empty
 * content but resources present) is surfaced as a placeholder so it is NOT
 * silently dropped: `[图片]` / `[文件] <name>` / `[语音]` / `[视频]` / `[表情]`
 * per the first resource's type. (Pure — unit-testable.)
 */
export function contentForIngress(m: NormalizedMessage): string {
  if (m.content.length > 0) return m.content;
  const first = m.resources[0];
  if (first === undefined) return m.content;
  switch (first.type) {
    case 'image':
      return '[图片]';
    case 'file':
      return first.fileName !== undefined ? `[文件] ${first.fileName}` : '[文件]';
    case 'audio':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'sticker':
      return '[表情]';
    default:
      return m.content;
  }
}

/**
 * Reply SendOptions: in a GROUP chat, reply to the originating message and @-mention
 * the sender so the bot's answer is threaded + addressed; in a p2p DM, no opts.
 */
function replyOptions(m: NormalizedMessage): SendOptions | undefined {
  if (m.chatType !== 'group') return undefined;
  return {
    replyTo: m.messageId,
    mentions: [
      {
        key: '',
        openId: m.senderId,
        ...(m.senderName !== undefined ? { name: m.senderName } : {}),
      },
    ],
  };
}

/** Factory for the Feishu (飞书) LarkChannel adapter. */
export function createFeishuAdapter(deps: FeishuAdapterDeps): FeishuAdapter {
  return new FeishuAdapter(deps);
}
