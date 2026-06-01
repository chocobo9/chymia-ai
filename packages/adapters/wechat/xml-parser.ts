// M13 WeChat adapter — inbound XML message parser.
//
// Source: clowder-design-supplement.md §C1 (POST /api/adapters/wechat/webhook 微信消息接收).
// WHY/edge-cases referenced from reference/clowder-ai-main WeComAgentAdapter.parseEvent
// (XML field shape: ToUserName/FromUserName/MsgType/Content/MsgId/CreateTime, image
// PicUrl+MediaId, event messages) — re-implemented here against fast-xml-parser, NOT copied.
//
// WeChat MP/WeCom inbound is an XML envelope, e.g.:
//   <xml><ToUserName><![CDATA[gh_...]]></ToUserName>
//        <FromUserName><![CDATA[oABC...]]></FromUserName>
//        <CreateTime>1700000000</CreateTime>
//        <MsgType><![CDATA[text]]></MsgType>
//        <Content><![CDATA[你好]]></Content>
//        <MsgId>1024</MsgId></xml>
// fast-xml-parser strips the CDATA wrappers and yields a plain object under `xml`.

import { XMLParser } from 'fast-xml-parser';

/** The WeChat inbound message kinds this adapter understands (§C1). */
export type WeChatInboundKind = 'text' | 'image' | 'event' | 'unknown';

/**
 * WeChatInboundMessage — normalized inbound WeChat message after XML parse.
 * `fromUser` is the platform OpenId (→ platformUserId); `toUser` is the official
 * account / agent id; `messageId` dedups (→ platformMessageId).
 */
export interface WeChatInboundMessage {
  /** Parsed message kind. */
  readonly kind: WeChatInboundKind;
  /** ToUserName — the official account / WeCom agent id. */
  readonly toUser: string;
  /** FromUserName — the sender OpenId (platform user id). */
  readonly fromUser: string;
  /** Platform message id (MsgId for messages, synthesized for events). */
  readonly messageId: string;
  /** CreateTime as epoch ms (WeChat sends epoch seconds; converted here). */
  readonly createdAt: number;
  /** Text content (text messages). Empty for non-text kinds. */
  readonly text: string;
  /** Image URL (image messages), if present. */
  readonly picUrl?: string;
  /** Media id (image/voice messages), if present. */
  readonly mediaId?: string;
  /** Event name (event messages, e.g. 'subscribe'), if present. */
  readonly event?: string;
  /** The raw parsed XML object (preserved for tracing / extension). */
  readonly raw: Record<string, unknown>;
}

// CreateTime arrives in epoch SECONDS; the rest of the system uses epoch ms.
const SECONDS_TO_MS = 1000;

// Shared parser instance. ignoreAttributes keeps the shape flat; parseTagValue
// off so numeric-looking ids/content stay strings (MsgId/Content must not be
// silently coerced to number — an all-digit message body would lose fidelity).
const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

/** Read a tag as a trimmed string, tolerating missing/object values. */
function readString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function classifyKind(msgType: string): WeChatInboundKind {
  switch (msgType) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'event':
      return 'event';
    default:
      return 'unknown';
  }
}

/**
 * Parse a WeChat inbound XML envelope into a {@link WeChatInboundMessage}.
 *
 * @param xml The raw request body (plaintext WeChat XML).
 * @param now Injectable clock (epoch ms) used to synthesize a message id for
 *   events lacking a MsgId. Defaults to Date.now.
 * @returns The normalized message, or null when the body is not a parseable
 *   WeChat envelope (missing `<xml>` root or no MsgType) — caller treats null
 *   as "ignore / ack" rather than throwing on malformed input.
 */
export function parseWeChatXml(
  xml: string,
  now: () => number = Date.now,
): WeChatInboundMessage | null {
  if (typeof xml !== 'string' || xml.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return null;
  }

  const root = extractRoot(parsed);
  if (root === null) {
    return null;
  }

  const msgType = readString(root.MsgType);
  if (msgType.length === 0) {
    return null;
  }

  const kind = classifyKind(msgType);
  const createTimeSeconds = Number(readString(root.CreateTime));
  const createdAt = Number.isFinite(createTimeSeconds) && createTimeSeconds > 0
    ? createTimeSeconds * SECONDS_TO_MS
    : now();

  const explicitId = readString(root.MsgId);
  const messageId = explicitId.length > 0 ? explicitId : `wechat-event-${now()}`;

  const base = {
    kind,
    toUser: readString(root.ToUserName),
    fromUser: readString(root.FromUserName),
    messageId,
    createdAt,
    text: kind === 'text' ? readString(root.Content) : '',
    raw: root,
  };

  const picUrl = readString(root.PicUrl);
  const mediaId = readString(root.MediaId);
  const event = readString(root.Event);

  return {
    ...base,
    ...(picUrl.length > 0 ? { picUrl } : {}),
    ...(mediaId.length > 0 ? { mediaId } : {}),
    ...(event.length > 0 ? { event } : {}),
  };
}

/** Pull the `<xml>` root object out of the parsed tree (tolerant of shapes). */
function extractRoot(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const inner = obj.xml;
  if (typeof inner === 'object' && inner !== null) {
    return inner as Record<string, unknown>;
  }
  // Some payloads may omit the wrapper; accept the object if it carries MsgType.
  if ('MsgType' in obj) {
    return obj;
  }
  return null;
}
