// packages/adapters/weixin/ilink-client.ts
// Tencent iLink Bot protocol client for PERSONAL WeChat (微信个人号).
//
// The QR-scan path Clowder uses (WeixinAdapter, F137): a bot connects to a
// personal WeChat account via Tencent's iLink gateway (ilinkai.weixin.qq.com) —
// no app registration, no public URL. Flow:
//   1. fetchQrCode()         GET get_bot_qrcode  (NO auth) → { qrUrl, qrPayload }
//   2. user scans the QR with personal WeChat
//   3. pollQrCodeStatus()    GET get_qrcode_status → confirmed → bot_token
//   4. getUpdates()          POST getupdates (long-poll, Bearer bot_token) → msgs
//   5. sendText()            POST sendmessage (needs the inbound context_token)
//
// Pure HTTP (injectable fetch), no SDK. Re-authored from the documented iLink
// shapes (pattern from reference WeixinAdapter; re-implemented, not copied).

import crypto from 'node:crypto';

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Injectable fetch (tests pass a stub; prod uses global fetch). */
export type FetchFn = typeof globalThis.fetch;

/** iLink session-expired error code (bot_token invalid → re-login). */
export const ERRCODE_SESSION_EXPIRED = -14;

/** TEXT message item type; bot message_type; FINISH state (openclaw-weixin). */
const ITEM_TYPE_TEXT = 1;
const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const CHANNEL_VERSION = '1.0.0';

const GETUPDATES_TIMEOUT_MS = 35_000;
const QRCODE_STATUS_TIMEOUT_MS = 40_000;
const GET_QRCODE_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 15_000;

/** The QR challenge to render + poll. */
export interface QrCode {
  /** The URL encoded in the QR image (scan target). */
  readonly qrUrl: string;
  /** The opaque payload to poll get_qrcode_status with. */
  readonly qrPayload: string;
}

/** Result of polling a QR's login status. */
export type QrStatus =
  | { readonly status: 'waiting' }
  | { readonly status: 'scanned' }
  | { readonly status: 'confirmed'; readonly botToken: string }
  | { readonly status: 'expired' }
  | { readonly status: 'error'; readonly message: string };

/** One inbound text message parsed from a getupdates batch. */
export interface InboundText {
  readonly chatId: string;
  readonly text: string;
  readonly messageId: string;
  /** Per-chat token required to reply (caller caches it by chatId). */
  readonly contextToken: string;
  readonly createdAtMs?: number;
}

/** Parsed getupdates result. */
export interface UpdatesResult {
  readonly messages: readonly InboundText[];
  readonly newCursor: string;
  readonly sessionExpired: boolean;
}

interface QrCodeResponse {
  readonly errcode?: number;
  readonly ret?: number;
  readonly errmsg?: string;
  readonly qrcode?: string;
  readonly qrcode_img_content?: string;
  readonly qrcode_url?: string;
}

interface QrStatusResponse {
  readonly errcode?: number;
  readonly ret?: number;
  readonly errmsg?: string;
  readonly status?: number | string;
  readonly bot_token?: string;
}

interface ILinkItem {
  readonly type?: number;
  readonly text_item?: { readonly text?: string };
}
interface ILinkMessage {
  readonly from_user_id?: string;
  readonly context_token?: string;
  readonly message_id?: string | number;
  readonly item_list?: readonly ILinkItem[];
  readonly create_time_ms?: number;
}
interface ILinkUpdate {
  readonly errcode?: number;
  readonly ret?: number;
  readonly errmsg?: string;
  readonly msgs?: readonly ILinkMessage[];
  readonly get_updates_buf?: string;
}
interface ILinkSendResponse {
  readonly errcode?: number;
  readonly ret?: number;
  readonly errmsg?: string;
}

function authHeaders(botToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${botToken}`,
  };
}

function errCodeOf(d: { errcode?: number; ret?: number }): number {
  return d.errcode ?? d.ret ?? 0;
}

/** GET get_bot_qrcode (no auth) → the QR to render + poll. */
export async function fetchQrCode(fetchFn: FetchFn): Promise<QrCode> {
  const res = await fetchFn(`${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: 'GET',
    signal: AbortSignal.timeout(GET_QRCODE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`get_bot_qrcode HTTP ${res.status}`);
  const data = (await res.json()) as QrCodeResponse;
  const code = errCodeOf(data);
  if (code !== 0) throw new Error(`get_bot_qrcode errcode ${code}: ${data.errmsg ?? 'unknown'}`);
  const qrUrl = data.qrcode_img_content ?? data.qrcode_url;
  const qrPayload = data.qrcode;
  if (qrUrl === undefined || qrPayload === undefined) {
    throw new Error('get_bot_qrcode: missing qr fields');
  }
  return { qrUrl, qrPayload };
}

/** GET get_qrcode_status → the login state (confirmed carries the bot_token). */
export async function pollQrCodeStatus(fetchFn: FetchFn, qrPayload: string): Promise<QrStatus> {
  const url = `${ILINK_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrPayload)}`;
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(QRCODE_STATUS_TIMEOUT_MS) });
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'network error' };
  }
  if (!res.ok) return { status: 'error', message: `HTTP ${res.status}` };
  const data = (await res.json()) as QrStatusResponse;
  const code = errCodeOf(data);
  if (code !== 0) return { status: 'error', message: data.errmsg ?? `errcode ${code}` };
  switch (data.status) {
    case 0:
    case 'wait':
      return { status: 'waiting' };
    case 1:
    case 'scanned':
      return { status: 'scanned' };
    case 2:
    case 'confirmed':
      return data.bot_token !== undefined && data.bot_token.length > 0
        ? { status: 'confirmed', botToken: data.bot_token }
        : { status: 'error', message: 'confirmed without bot_token' };
    case 3:
    case 'expired':
      return { status: 'expired' };
    default:
      return { status: 'error', message: `unknown status ${String(data.status)}` };
  }
}

/** Parse a raw getupdates response into our text messages + cursor + expiry flag. */
export function parseUpdates(raw: ILinkUpdate, prevCursor: string): UpdatesResult {
  const code = errCodeOf(raw);
  if (code === ERRCODE_SESSION_EXPIRED) {
    return { messages: [], newCursor: prevCursor, sessionExpired: true };
  }
  if (code !== 0) {
    return { messages: [], newCursor: prevCursor, sessionExpired: false };
  }
  const newCursor = raw.get_updates_buf ?? prevCursor;
  const messages: InboundText[] = [];
  for (const m of raw.msgs ?? []) {
    const chatId = m.from_user_id;
    const contextToken = m.context_token;
    if (chatId === undefined || contextToken === undefined) continue;
    const first = m.item_list?.[0];
    if (first === undefined || (first.type ?? ITEM_TYPE_TEXT) !== ITEM_TYPE_TEXT) continue;
    const text = first.text_item?.text;
    if (text === undefined || text.length === 0) continue;
    messages.push({
      chatId,
      text,
      contextToken,
      messageId: m.message_id !== undefined ? String(m.message_id) : `weixin-${chatId}`,
      ...(m.create_time_ms !== undefined ? { createdAtMs: m.create_time_ms } : {}),
    });
  }
  return { messages, newCursor, sessionExpired: false };
}

/** POST getupdates (long-poll). Returns parsed messages + the advanced cursor. */
export async function getUpdates(
  fetchFn: FetchFn,
  botToken: string,
  cursor: string,
  signal?: AbortSignal,
): Promise<UpdatesResult> {
  const res = await fetchFn(`${ILINK_BASE_URL}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: authHeaders(botToken),
    body: JSON.stringify({ get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } }),
    signal:
      signal !== undefined
        ? AbortSignal.any([signal, AbortSignal.timeout(GETUPDATES_TIMEOUT_MS + 5_000)])
        : AbortSignal.timeout(GETUPDATES_TIMEOUT_MS + 5_000),
  });
  if (!res.ok) throw new Error(`getupdates HTTP ${res.status}`);
  return parseUpdates((await res.json()) as ILinkUpdate, cursor);
}

/** POST sendmessage — send a text reply to `chatId` using its `contextToken`. */
export async function sendText(
  fetchFn: FetchFn,
  botToken: string,
  chatId: string,
  contextToken: string,
  text: string,
): Promise<void> {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: chatId,
      client_id: `choco-weixin-${crypto.randomUUID()}`,
      message_type: MESSAGE_TYPE_BOT,
      context_token: contextToken,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text } }],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  };
  const res = await fetchFn(`${ILINK_BASE_URL}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: authHeaders(botToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`sendmessage HTTP ${res.status}`);
  const data = (await res.json()) as ILinkSendResponse;
  const code = errCodeOf(data);
  if (code !== 0) throw new Error(`sendmessage errcode ${code}: ${data.errmsg ?? 'unknown'}`);
}
