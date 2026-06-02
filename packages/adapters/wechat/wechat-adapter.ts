// M13 WeChat (WeCom) adapter — PlatformAdapter implementation + factory.
//
// Source: clowder-design-supplement.md §A10 (PlatformMapping), §B4 (adapter
// buffering), §C1 (POST /api/adapters/wechat/webhook). PlatformAdapter contract:
// packages/shared/src/types/platform.ts. WHY/edge-cases referenced from
// reference/clowder-ai-main WeComAgentAdapter (signature verification shape,
// token refresh, message/send chunking) — re-implemented, NOT copied.
//
// Flow (frozen, see §C1 + app-factory submitPlatformMessage seam):
//   inbound WeChat XML POST → parseWeChatXml → build IncomingPlatformMessage
//   → onMessage handler (default: submitPlatformMessage) → route+persist pipeline
//   → for each agent reply: bufferReply (§B4 sentence/length flush) → outbound
//   sender → WeCom message/send for the resolved channel.
// The adapter does NOT reimplement routing; it owns inbound parsing + outbound send.

import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type {
  AgentId,
  IncomingPlatformMessage,
  PlatformAdapter,
  StoredMessage,
} from '@choco/shared';

import { parseWeChatXml } from './xml-parser.js';
import { TokenManager, type FetchFn } from './token-manager.js';

/** Result of the platform-ingress seam (mirrors app-factory PlatformIngressResult). */
export interface IngressResult {
  readonly threadId: string;
  readonly userId: string;
  readonly replies: StoredMessage[];
}

/** The ingress seam an adapter drives for one inbound message (buildApp().submitPlatformMessage). */
export type SubmitPlatformMessage = (
  incoming: IncomingPlatformMessage,
) => Promise<IngressResult>;

/**
 * OutboundSender — the network seam for pushing a reply chunk back to WeChat.
 * Production wires {@link createWeComOutboundSender}; tests inject a fake to
 * capture sent chunks without real network.
 */
export type OutboundSender = (
  channelId: string,
  content: string,
  agentId?: AgentId,
) => Promise<void>;

/** Structured logger seam (no console.log per project rules). */
export interface AdapterLogger {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

const NOOP_LOGGER: AdapterLogger = { warn: () => {}, error: () => {} };

/** WeChat adapter config — all secrets/urls come from env/config, never literals. */
export interface WeChatAdapterConfig {
  /** WeCom corpId (CHOCO_WECHAT_CORP_ID). */
  readonly corpId: string;
  /** WeCom app secret (CHOCO_WECHAT_SECRET). */
  readonly secret: string;
  /** Callback token for SHA1 signature verification (CHOCO_WECHAT_TOKEN). */
  readonly token: string;
  /** API base (CHOCO_WECHAT_API_BASE). */
  readonly apiBase: string;
}

/** Dependencies for {@link createWeChatAdapter}. */
export interface WeChatAdapterDeps {
  /** The Fastify instance from buildApp().api — the inbound webhook is registered here. */
  readonly api: FastifyInstance;
  /** The platform-ingress seam from buildApp().submitPlatformMessage. */
  readonly submitPlatformMessage: SubmitPlatformMessage;
  /** WeCom credentials + urls (env-sourced). */
  readonly config: WeChatAdapterConfig;
  /**
   * Injectable outbound sender. Tests pass a fake; production omits it and the
   * adapter builds a real WeCom message/send sender from a {@link TokenManager}.
   */
  readonly outboundSender?: OutboundSender;
  /** Injectable HTTP (forwarded to the default sender + token manager). */
  readonly fetchFn?: FetchFn;
  /** Injectable clock (epoch ms). Defaults to Date.now. */
  readonly now?: () => number;
  /** Structured logger. Defaults to silent. */
  readonly logger?: AdapterLogger;
}

/** Inbound-handler signature (matches PlatformAdapter.onMessage). */
type InboundHandler = (message: IncomingPlatformMessage) => Promise<void>;

const ADAPTER_NAME = 'wechat';
const WEBHOOK_PATH = '/api/adapters/wechat/webhook';

// ── §B4 buffering constants (sentence-level buffer + max wait) ──
// Source: clowder-design-supplement.md §B4. A reply is flushed to the platform
// at a sentence boundary OR once it exceeds the length threshold. The 3s max-wait
// bounds streaming latency; submitPlatformMessage returns finalized replies (no
// stream wait), so flushing here is driven by the sentence/length rule and the
// final residual flush — the timer constant is retained for the streaming model.
const SENTENCE_TERMINATORS = ['。', '！', '？', '.', '!', '?', '\n'];
const BUFFER_FLUSH_MAX_CHARS = 500; // §B4: buffer.length > 500 forces a flush.
const BUFFER_MAX_WAIT_MS = 3000; // §B4: 3s max wait (streaming-model bound).

/**
 * Split a finalized reply into sentence/length-bounded chunks per §B4: accumulate
 * until a sentence terminator OR the length threshold, then emit a chunk. The
 * trailing residual is emitted as a final chunk. Pure — returns new strings,
 * mutates nothing.
 */
export function bufferReply(content: string): string[] {
  const chunks: string[] = [];
  let buffer = '';
  for (const char of content) {
    buffer += char;
    const atSentenceEnd = SENTENCE_TERMINATORS.includes(char);
    if (atSentenceEnd || buffer.length > BUFFER_FLUSH_MAX_CHARS) {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        chunks.push(trimmed);
      }
      buffer = '';
    }
  }
  const residual = buffer.trim();
  if (residual.length > 0) {
    chunks.push(residual);
  }
  return chunks;
}

/**
 * Compute the WeChat callback SHA1 signature: sha1(sort([token, timestamp,
 * nonce, payload]).join('')). Used to verify inbound POSTs / the GET echo.
 * // Pattern from Clowder WeComAgentAdapter.computeSignature (re-implemented).
 */
export function computeSignature(
  token: string,
  timestamp: string,
  nonce: string,
  payload: string,
): string {
  const params = [token, timestamp, nonce, payload].sort();
  return crypto.createHash('sha1').update(params.join('')).digest('hex');
}

/** Query params WeChat attaches to webhook requests for signature verification. */
interface WebhookQuery {
  readonly signature?: string;
  readonly msg_signature?: string;
  readonly timestamp?: string;
  readonly nonce?: string;
  readonly echostr?: string;
}

/**
 * Verify a WeChat webhook signature when a token is configured. Returns true
 * when verification passes OR no token is configured (plaintext/dev mode).
 */
function verifySignature(
  token: string,
  query: WebhookQuery,
  payload: string,
): boolean {
  if (token.length === 0) {
    return true; // No token configured → plaintext mode, accept.
  }
  const provided = query.msg_signature ?? query.signature;
  if (
    typeof provided !== 'string' ||
    typeof query.timestamp !== 'string' ||
    typeof query.nonce !== 'string'
  ) {
    return false;
  }
  const expected = computeSignature(token, query.timestamp, query.nonce, payload);
  return expected === provided;
}

/**
 * WeChatAdapter — the {@link PlatformAdapter} implementation. Construct via
 * {@link createWeChatAdapter}.
 */
class WeChatAdapter implements PlatformAdapter {
  readonly name = ADAPTER_NAME;

  private readonly api: FastifyInstance;
  private readonly submit: SubmitPlatformMessage;
  private readonly config: WeChatAdapterConfig;
  private readonly outbound: OutboundSender;
  private readonly logger: AdapterLogger;
  private handler: InboundHandler;
  private started = false;

  constructor(deps: WeChatAdapterDeps) {
    this.api = deps.api;
    this.submit = deps.submitPlatformMessage;
    this.config = deps.config;
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.outbound =
      deps.outboundSender ??
      createWeComOutboundSender({
        config: deps.config,
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });
    // Default inbound handler: drive the ingress seam, then send replies back.
    this.handler = (message) => this.dispatchAndReply(message);
    this.registerWebhook();
  }

  /** Register POST + GET /api/adapters/wechat/webhook on the injected Fastify api. */
  private registerWebhook(): void {
    // WeChat posts raw XML (text/xml | application/xml). Fastify has no built-in
    // XML parser, so capture the body verbatim as a string for parseWeChatXml +
    // signature verification. Guard double-registration (idempotent if the api
    // is shared / re-wired). This only adds parsers; it does not alter existing routes.
    this.registerXmlBodyParser('text/xml');
    this.registerXmlBodyParser('application/xml');

    // GET: WeChat URL-verification echo (returns echostr when signature matches).
    this.api.get(WEBHOOK_PATH, async (request, reply) => {
      const query = request.query as WebhookQuery;
      const echo = query.echostr ?? '';
      if (!verifySignature(this.config.token, query, echo)) {
        await reply.code(401).send('invalid signature');
        return;
      }
      await reply.code(200).send(echo);
    });

    // POST: inbound message. Parse XML → IncomingPlatformMessage → handler.
    this.api.post(WEBHOOK_PATH, async (request, reply) => {
      const body = this.readBody(request);
      const query = request.query as WebhookQuery;

      if (!verifySignature(this.config.token, query, body)) {
        this.logger.warn({ path: WEBHOOK_PATH }, 'wechat webhook signature mismatch');
        await reply.code(401).send('invalid signature');
        return;
      }

      const parsed = parseWeChatXml(body);
      // WeChat expects a fast 200 ack on any well-formed callback; non-text /
      // unparseable payloads are acked-and-ignored (no agent routing).
      if (parsed === null || parsed.kind !== 'text' || parsed.text.length === 0) {
        await reply.code(200).send('');
        return;
      }

      const incoming: IncomingPlatformMessage = {
        adapterName: ADAPTER_NAME,
        channelId: parsed.fromUser,
        platformUserId: parsed.fromUser,
        platformMessageId: parsed.messageId,
        text: parsed.text,
        receivedAt: parsed.createdAt,
        raw: parsed.raw,
      };

      // Hand to the registered handler. Errors are logged, never leaked; we
      // still ack 200 so WeChat does not hammer retries on a transient failure.
      try {
        await this.handler(incoming);
      } catch (err) {
        this.logger.error(
          { err: String(err), messageId: parsed.messageId },
          'wechat inbound handler failed',
        );
      }
      await reply.code(200).send('');
    });
  }

  /** Add a raw-string body parser for one XML content type (idempotent). */
  private registerXmlBodyParser(contentType: string): void {
    try {
      this.api.addContentTypeParser(
        contentType,
        { parseAs: 'string' },
        (_request, body, done) => {
          done(null, body);
        },
      );
    } catch {
      // Already registered (shared api / re-wire) — safe to ignore.
    }
  }

  /** Extract the raw XML string from the Fastify request body (string or buffer). */
  private readBody(request: FastifyRequest): string {
    const body = request.body;
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body.toString('utf8');
    if (body !== null && body !== undefined && typeof body === 'object') {
      // A content-type parser may have already produced an object; re-serialize
      // is unsafe, so fall back to empty (parser returns null → acked-ignored).
      return '';
    }
    return '';
  }

  /** Default handler: route the message through ingress, then send each reply back. */
  private async dispatchAndReply(message: IncomingPlatformMessage): Promise<void> {
    const result = await this.submit(message);
    for (const replyMsg of result.replies) {
      await this.sendMessage(
        message.channelId,
        replyMsg.content,
        replyMsg.agentId ?? undefined,
      );
    }
  }

  async start(): Promise<void> {
    // Webhook is registered at construction (the Fastify instance is shared and
    // started by buildApp); start() marks the adapter live for symmetry with
    // long-poll adapters and is idempotent.
    this.started = true;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.started = false;
    return Promise.resolve();
  }

  /** True once start() has been called (test/runtime introspection). */
  get isStarted(): boolean {
    return this.started;
  }

  /**
   * Send a reply to a WeChat channel. Applies §B4 sentence/length buffering:
   * the reply is split into chunks, each pushed via the outbound sender in order.
   */
  async sendMessage(channelId: string, content: string, agentId?: AgentId): Promise<void> {
    const chunks = bufferReply(content);
    for (const chunk of chunks) {
      await this.outbound(channelId, chunk, agentId);
    }
  }

  onMessage(handler: InboundHandler): void {
    this.handler = handler;
  }
}

/** Config for {@link createWeComOutboundSender}. */
interface OutboundSenderConfig {
  readonly config: WeChatAdapterConfig;
  readonly fetchFn?: FetchFn;
  readonly now?: () => number;
}

/** Shape of the WeCom message/send JSON response. */
interface MessageSendResponse {
  readonly errcode?: number;
  readonly errmsg?: string;
}

/**
 * Build the production outbound sender: resolves an access_token via a
 * {@link TokenManager} and POSTs a text message to WeCom message/send. On a
 * 40001/42001 token error it forces a refresh and retries once.
 * // Pattern from Clowder WeComAgentAdapter.sendViaApi (re-implemented).
 */
export function createWeComOutboundSender(deps: OutboundSenderConfig): OutboundSender {
  const fetchFn: FetchFn = deps.fetchFn ?? globalThis.fetch;
  const apiBase = deps.config.apiBase.replace(/\/+$/, '');
  const tokenManager = new TokenManager({
    corpId: deps.config.corpId,
    secret: deps.config.secret,
    apiBase,
    ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  const TOKEN_ERR_CODES = new Set([40001, 42001, 40014]);

  async function post(token: string, channelId: string, content: string): Promise<MessageSendResponse> {
    const url = `${apiBase}/message/send?access_token=${encodeURIComponent(token)}`;
    const payload = {
      touser: channelId,
      msgtype: 'text',
      text: { content },
    };
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`WeChat message/send HTTP ${res.status}: ${res.statusText}`);
    }
    return (await res.json()) as MessageSendResponse;
  }

  return async function send(channelId: string, content: string): Promise<void> {
    const token = await tokenManager.getToken();
    let data = await post(token, channelId, content);

    if (typeof data.errcode === 'number' && TOKEN_ERR_CODES.has(data.errcode)) {
      tokenManager.forceRefresh();
      const fresh = await tokenManager.getToken();
      data = await post(fresh, channelId, content);
    }

    if (typeof data.errcode === 'number' && data.errcode !== 0) {
      throw new Error(
        `WeChat message/send errcode ${data.errcode}: ${data.errmsg ?? 'unknown'}`,
      );
    }
  };
}

/**
 * createWeChatAdapter — factory for the WeChat {@link PlatformAdapter}.
 * Registers the inbound webhook on deps.api at construction and returns the
 * adapter. Caller invokes start()/stop() and may override onMessage.
 */
export function createWeChatAdapter(deps: WeChatAdapterDeps): PlatformAdapter {
  return new WeChatAdapter(deps);
}

/** Exported buffering constants (for QA / tuning visibility). */
export const WECHAT_BUFFER_CONSTANTS = {
  flushMaxChars: BUFFER_FLUSH_MAX_CHARS,
  maxWaitMs: BUFFER_MAX_WAIT_MS,
  sentenceTerminators: SENTENCE_TERMINATORS,
} as const;
