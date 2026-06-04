// packages/adapters/feishu/feishu-client.ts
// Feishu (飞书/Lark) HTTP surface — pure fetch (no SDK): tenant_access_token,
// send text, and the inbound event parser. The WebSocket long-connection (which
// avoids a public callback URL) is the SDK's job (feishu-adapter); everything
// here is injectable-fetch testable.
//
// Re-authored from the documented Feishu open APIs (pattern from Clowder's
// FeishuTokenManager / FeishuAdapter.parseEvent — re-implemented, not copied).

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

/** Injectable fetch (tests pass a stub; prod uses global fetch). */
export type FetchFn = typeof globalThis.fetch;

/** One inbound p2p text message parsed from an im.message.receive_v1 event. */
export interface FeishuInbound {
  readonly chatId: string;
  readonly text: string;
  readonly messageId: string;
  readonly senderId: string;
}

/** A small token cache so each reply doesn't re-mint a tenant_access_token. */
export class FeishuTokenCache {
  private token: string | undefined;
  private expiresAt = 0;
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly fetchFn: FetchFn = globalThis.fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    if (this.token !== undefined && this.now() < this.expiresAt) return this.token;
    const res = await this.fetchFn(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    if (!res.ok) throw new Error(`feishu token HTTP ${res.status}`);
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`feishu token code ${data.code}: ${data.msg ?? 'unknown'}`);
    }
    if (data.tenant_access_token === undefined) throw new Error('feishu token: no token in response');
    this.token = data.tenant_access_token;
    // Refresh 5 minutes early (expire is seconds).
    this.expiresAt = this.now() + ((data.expire ?? 7200) - 300) * 1000;
    return this.token;
  }
}

/** Send a text reply to a Feishu chat (im/v1/messages, receive_id_type=chat_id). */
export async function sendFeishuText(
  fetchFn: FetchFn,
  tenantToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetchFn(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${tenantToken}`,
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    }),
  });
  if (!res.ok) throw new Error(`feishu send HTTP ${res.status}`);
  const data = (await res.json()) as { code?: number; msg?: string };
  if (data.code !== undefined && data.code !== 0) {
    throw new Error(`feishu send code ${data.code}: ${data.msg ?? 'unknown'}`);
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Parse an im.message.receive_v1 event into a p2p text inbound, or null when it's
 * not a private text message (MVP: DM + text only). The SDK hands the handler the
 * event payload `{ header, event }`.
 */
export function parseFeishuEvent(data: unknown): FeishuInbound | null {
  const body = asRecord(data);
  if (body === undefined) return null;
  // The SDK may pass the inner event directly or the full `{header,event}`.
  const header = asRecord(body.header);
  if (header !== undefined && header.event_type !== 'im.message.receive_v1') return null;
  const event = asRecord(body.event) ?? body;
  const message = asRecord(event.message);
  if (message === undefined) return null;
  if (message.chat_type !== 'p2p') return null; // MVP: DM only
  if (message.message_type !== 'text') return null;
  const chatId = typeof message.chat_id === 'string' ? message.chat_id : undefined;
  const messageId = typeof message.message_id === 'string' ? message.message_id : undefined;
  if (chatId === undefined || messageId === undefined) return null;

  let content: Record<string, unknown> | undefined;
  try {
    content = asRecord(JSON.parse(message.content as string));
  } catch {
    return null;
  }
  const text = content !== undefined && typeof content.text === 'string' ? content.text : undefined;
  if (text === undefined || text.length === 0) return null;

  const sender = asRecord(event.sender);
  const senderId = asRecord(sender?.sender_id)?.open_id;
  return {
    chatId,
    text,
    messageId,
    senderId: typeof senderId === 'string' ? senderId : 'unknown',
  };
}
