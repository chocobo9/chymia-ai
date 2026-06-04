// M13 WeChat adapter — signature-verification EDGE + ADVERSARIAL suite (QA role).
//
// Authored by the independent QA (NOT the dev), per CLAUDE §0.5.3. Proves the
// SHA1 callback-signature defense: a forged/tampered request is REJECTED with
// 401 and NOT routed; a correctly-signed request passes; the GET echo only
// returns echostr when the signature is valid; empty token → plaintext mode.
//
// Signatures are REAL — computed with the same crypto the product uses over the
// sorted (token, timestamp, nonce, payload) tuple. Realistic WeCom token/nonce.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { AgentId, AgentMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import {
  createWeChatAdapter,
  computeSignature,
  type OutboundSender,
} from '@choco/adapters/wechat';
import { replyScript, CLAUDE } from '../../api/helpers.js';
import { FakeAgentService } from '../../invocation/fake-agent-service.js';

const SENDER_OPENID = 'oWxYz09876543210abcdEFghIJklmn';
const OFFICIAL_ACCOUNT = 'gh_7f3a9c2e1b08';
// A realistic, non-empty WeCom callback token (base64-ish), so signature mode is ON.
const CALLBACK_TOKEN = 'kT8wQ2zR7yLpVn4mXcB1aD6fH0sJ9eU3';
const TIMESTAMP = '1700000000';
const NONCE = 'Wm9uY2VOb25jZTEyMzQ1Ng';

const SIGNED_CONFIG = {
  corpId: 'ww1a2b3c4d5e6f7g8',
  agentId: '1000002',
  secret: 'Xy7Qa9Bc3Df1Gh5Jk2Lm8Np4Qr6St0Uv',
  token: CALLBACK_TOKEN,
  apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
} as const;

const PLAINTEXT_CONFIG = { ...SIGNED_CONFIG, token: '' } as const;

interface SentChunk {
  readonly channelId: string;
  readonly content: string;
  readonly agentId?: AgentId;
}

function buildWeChatXml(text: string, msgId: string): string {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
    `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${text}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

function injectApp(
  scripts: Record<string, readonly (readonly AgentMessage[])[]>,
): BuiltApp {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }
  return buildApp({ db, agentServices: fakes });
}

interface Harness {
  readonly app: BuiltApp;
  readonly sent: SentChunk[];
}

async function makeHarness(
  config: typeof SIGNED_CONFIG | typeof PLAINTEXT_CONFIG,
): Promise<Harness> {
  const app = injectApp({ 'claude-opus': [replyScript(CLAUDE, '已确认，开始处理。')] });
  const sent: SentChunk[] = [];
  const fakeSender: OutboundSender = async (channelId, content, agentId) => {
    sent.push({ channelId, content, ...(agentId !== undefined ? { agentId } : {}) });
  };
  const adapter = createWeChatAdapter({
    api: app.api,
    submitPlatformMessage: app.submitPlatformMessage,
    config,
    outboundSender: fakeSender,
  });
  await adapter.start();
  await app.api.ready();
  return { app, sent };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('WeChat POST signature verification (ADVERSARIAL)', () => {
  it('accepts and ROUTES a correctly-signed POST (200, reply sent back)', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const body = buildWeChatXml('@claude-opus 上线前还要做什么检查', '3101');
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, body);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(SENDER_OPENID);
  });

  it('REJECTS a forged signature with 401 and does NOT route the message', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const body = buildWeChatXml('我是伪造的回调，请不要路由', '3102');
    // Attacker fabricates a plausible-looking SHA1 hex string without the token.
    const forged = crypto.createHash('sha1').update('attacker-guess').digest('hex');

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?signature=${forged}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0); // forged request was rejected, never routed
  });

  it('REJECTS a request whose BODY was tampered after signing (signature no longer matches)', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const originalBody = buildWeChatXml('原始内容', '3103');
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, originalBody);
    const tamperedBody = buildWeChatXml('被中间人篡改后的内容', '3103');

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      headers: { 'content-type': 'text/xml' },
      payload: tamperedBody, // body changed → signature is over the old body
    });

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('REJECTS when the timestamp is tampered (signature computed over a different timestamp)', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const body = buildWeChatXml('时间戳重放尝试', '3104');
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, body);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=1700009999&nonce=${NONCE}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('REJECTS when required signature query params are missing (signature present, nonce absent)', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const body = buildWeChatXml('缺少 nonce 的请求', '3105');
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, body);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=${TIMESTAMP}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('accepts a request signed with msg_signature (WeCom encrypted-mode param name)', async () => {
    const { app, sent } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const body = buildWeChatXml('@claude-opus 用 msg_signature 参数名', '3106');
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, body);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('WeChat GET URL-verification echo (ADVERSARIAL)', () => {
  it('echoes echostr ONLY when the signature over echostr is valid', async () => {
    const { app } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const echostr = 'challenge-5f3a9c2e1b08-verify';
    const signature = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, echostr);

    const res = await app.api.inject({
      method: 'GET',
      url: `/api/adapters/wechat/webhook?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${echostr}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echostr);
  });

  it('REJECTS the GET challenge with 401 when the signature is invalid (no echostr leak)', async () => {
    const { app } = await makeHarness(SIGNED_CONFIG);
    cleanups.push(app.close);

    const echostr = 'challenge-should-not-be-echoed';
    const forged = crypto.createHash('sha1').update('not-the-token').digest('hex');

    const res = await app.api.inject({
      method: 'GET',
      url: `/api/adapters/wechat/webhook?signature=${forged}&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${echostr}`,
    });

    expect(res.statusCode).toBe(401);
    expect(res.body).not.toBe(echostr);
  });
});

describe('WeChat plaintext mode (EDGE — empty token)', () => {
  it('accepts an unsigned POST when no token is configured (dev/plaintext mode)', async () => {
    const { app, sent } = await makeHarness(PLAINTEXT_CONFIG);
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/adapters/wechat/webhook',
      headers: { 'content-type': 'text/xml' },
      payload: buildWeChatXml('@claude-opus 无签名的开发环境消息', '3201'),
    });

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('computeSignature — algorithm correctness (EDGE)', () => {
  it('is order-independent in inputs: SHA1 over the lexicographically sorted tuple', () => {
    // The product sorts [token, timestamp, nonce, payload] before hashing, so the
    // signature must NOT depend on the argument order — recompute by hand to prove
    // it equals sha1 of the sorted join (real algorithm, not a snapshot).
    const payload = '<xml><MsgType>text</MsgType></xml>';
    const expected = crypto
      .createHash('sha1')
      .update([CALLBACK_TOKEN, TIMESTAMP, NONCE, payload].sort().join(''))
      .digest('hex');
    expect(computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, payload)).toBe(expected);
  });

  it('produces a different signature when any single input changes (collision-resistance smoke)', () => {
    const payload = '<xml><MsgType>text</MsgType></xml>';
    const base = computeSignature(CALLBACK_TOKEN, TIMESTAMP, NONCE, payload);
    expect(computeSignature(CALLBACK_TOKEN, '1700000001', NONCE, payload)).not.toBe(base);
    expect(computeSignature(CALLBACK_TOKEN, TIMESTAMP, 'differentNonce', payload)).not.toBe(base);
    expect(computeSignature('differentToken', TIMESTAMP, NONCE, payload)).not.toBe(base);
  });
});
