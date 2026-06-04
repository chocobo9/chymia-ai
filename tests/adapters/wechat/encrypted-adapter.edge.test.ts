// M13 WeChat (WeCom) ENCRYPTED-mode adapter — EDGE + ADVERSARIAL webhook gate (QA role).
//
// Authored by the INDEPENDENT QA instance (dev≠QA, CLAUDE §0.5.3): the dev shipped the
// encrypted decrypt→route→reply happy path in encrypted-inbound.test.ts. This file
// gates the encrypted-mode webhook's dark corners by driving the REAL Fastify routes
// (app.api.inject — no mocked adapter internals):
//   • POST with a WRONG msg_signature → 401, never decrypted/routed (no reply sent).
//   • POST with a VALID signature but TAMPERED ciphertext → decrypt fails → 401.
//   • POST with NO <Encrypt> element (encrypted mode) → 200 ack, NOT routed.
//   • GET echo with a WRONG signature → 401 (no decrypt attempted).
//   • REGRESSION: PLAINTEXT mode (encodingAesKey ABSENT) still routes a raw XML POST —
//     the new encrypted branch must not break the prior plaintext path.
//
// The signature is verified over the <Encrypt> BLOB (encrypted mode) / over the whole
// body (plaintext mode) — the two cases here pin both. Realistic WeCom OpenId channels
// + CJK @mentions; injected FakeAgentService — no network. No product code modified.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import {
  createWeChatAdapter,
  computeSignature,
  deriveAesKeyIv,
  msgSignature,
  encryptWeComMessage,
  type OutboundSender,
} from '@choco/adapters/wechat';
import { replyScript, CLAUDE } from '../../api/helpers.js';
import { FakeAgentService } from '../../invocation/fake-agent-service.js';

const CORP_ID = 'ww8f1a2b3c4d5e6f70';
const SENDER_OPENID = 'oWxYz09876543210abcdEFghIJklmn';
const TOKEN = 'choco-wecom-callback-7Hq2';
const WEBHOOK = '/api/adapters/wechat/webhook';
// A valid 43-char EncodingAESKey (32 bytes base64, trailing '=' stripped).
const ENCODING_AES_KEY = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '');

const ENCRYPTED_CONFIG = {
  corpId: CORP_ID,
  agentId: '1000002',
  secret: 'Xk9aQ3mZ7pL1rT8vN6wYbC4dE2fG0hJ5kU',
  token: TOKEN,
  apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
  encodingAesKey: ENCODING_AES_KEY,
} as const;

// Same config WITHOUT the EncodingAESKey → the adapter runs in PLAINTEXT mode.
const PLAINTEXT_CONFIG = {
  corpId: CORP_ID,
  agentId: '1000002',
  secret: 'Xk9aQ3mZ7pL1rT8vN6wYbC4dE2fG0hJ5kU',
  token: TOKEN,
  apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
} as const;

function buildWeChatXml(text: string, msgId: string): string {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${CORP_ID}]]></ToUserName>` +
    `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${text}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

interface SentChunk {
  readonly channelId: string;
  readonly content: string;
  readonly agentId?: AgentId;
}

/** Build a wired app + a capturing fake outbound sender for one config. */
function wireAdapter(config: typeof ENCRYPTED_CONFIG | typeof PLAINTEXT_CONFIG): {
  app: BuiltApp;
  sent: SentChunk[];
} {
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到，处理中。')]) },
  });
  const sent: SentChunk[] = [];
  const fakeSender: OutboundSender = async (channelId, content, agentId) => {
    sent.push({ channelId, content, ...(agentId !== undefined ? { agentId } : {}) });
  };
  createWeChatAdapter({
    api: app.api,
    submitPlatformMessage: app.submitPlatformMessage,
    config,
    outboundSender: fakeSender,
  });
  return { app, sent };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('WeChat ENCRYPTED webhook — POST signature + decrypt rejection (adversarial)', () => {
  it('[adversarial] a WRONG msg_signature over a valid <Encrypt> blob → 401, NOT routed', async () => {
    // Arrange — a perfectly valid encrypted body, but sign it with the WRONG token so
    // the msg_signature over the Encrypt blob does not match.
    const { app, sent } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const encrypt = encryptWeComMessage(buildWeChatXml('@claude-opus 看一下', '5001'), keyIv, CORP_ID);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const ts = '1717398100';
    const nonce = 'qa-bad-sig-01';
    const badSig = msgSignature('the-wrong-token', ts, nonce, encrypt);

    // Act
    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${badSig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    // Assert — rejected before decrypt/route; the agent reply was never sent.
    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('[adversarial] a VALID signature over TAMPERED ciphertext → decrypt fails → 401, NOT routed', async () => {
    // Arrange — flip bytes inside the Encrypt blob, then compute a signature that
    // MATCHES the tampered blob (so signature verification PASSES). The decrypt itself
    // must then fail (bad padding / corrupt blocks) → 401.
    const { app, sent } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const good = encryptWeComMessage(buildWeChatXml('@claude-opus 正常内容', '5002'), keyIv, CORP_ID);
    // Corrupt the FINAL AES block, which carries the PKCS7 pad bytes: flipping a byte
    // there makes the post-decrypt pad length invalid → decryptWeComMessage throws.
    // (Corrupting a middle block can still unpad cleanly and merely yield garbage XML
    // that is ack-and-ignored — we need a genuine decrypt FAILURE here.)
    const cipherBytes = Buffer.from(good, 'base64');
    cipherBytes[cipherBytes.length - 1] ^= 0xff; // flip the last ciphertext byte
    const tampered = cipherBytes.toString('base64');
    const body = `<xml><Encrypt><![CDATA[${tampered}]]></Encrypt></xml>`;
    const ts = '1717398200';
    const nonce = 'qa-tamper-02';
    // Sign the TAMPERED blob so the signature gate PASSES and we reach the decrypt.
    const sig = msgSignature(TOKEN, ts, nonce, tampered);

    // Act
    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    // Assert — signature passed but decrypt failed → 401, nothing routed.
    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('[edge] a POST with NO <Encrypt> element (encrypted mode) → 200 ack, NOT routed', async () => {
    // Arrange — a plaintext-looking XML body in ENCRYPTED mode. There is no <Encrypt>
    // to decrypt, so the adapter ack-and-ignores (200, empty) without routing.
    const { app, sent } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const ts = '1717398300';
    const nonce = 'qa-no-encrypt-03';
    const body = buildWeChatXml('@claude-opus 这是没有 Encrypt 的明文', '5003');
    // Even a body-level valid signature must not cause routing in encrypted mode.
    const sig = computeSignature(TOKEN, ts, nonce, body);

    // Act
    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    // Assert — fast ack, but the message was NOT decrypted/routed.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(sent).toHaveLength(0);
  });

  it('[happy] a valid encrypted POST is decrypted → routed → replied (control for the rejections above)', async () => {
    const { app, sent } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const encrypt = encryptWeComMessage(buildWeChatXml('@claude-opus 帮我看下', '5004'), keyIv, CORP_ID);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const ts = '1717398400';
    const nonce = 'qa-good-04';
    const sig = msgSignature(TOKEN, ts, nonce, encrypt);

    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(SENDER_OPENID);
    expect(sent[0]?.content).toBe('已收到，处理中。');
  });
});

describe('WeChat ENCRYPTED webhook — GET echo signature gate (adversarial)', () => {
  it('[adversarial] GET echo with a WRONG signature → 401 (no decrypt, no echo body)', async () => {
    // Arrange — a valid encrypted echostr, but a signature that does not match it.
    const { app } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const echoCipher = encryptWeComMessage('echo-challenge-7710', keyIv, CORP_ID);
    const ts = '1717398500';
    const nonce = 'qa-echo-bad-05';
    const badSig = '0'.repeat(40); // right shape, wrong digest

    // Act
    const res = await app.api.inject({
      method: 'GET',
      url: `${WEBHOOK}?msg_signature=${badSig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echoCipher)}`,
    });

    // Assert — rejected; the plaintext echo is never returned.
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('echo-challenge-7710');
  });

  it('[edge] GET echo with a VALID signature returns the DECRYPTED plaintext (control)', async () => {
    const { app } = wireAdapter(ENCRYPTED_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const echoPlain = 'echo-challenge-7710';
    const echoCipher = encryptWeComMessage(echoPlain, keyIv, CORP_ID);
    const ts = '1717398600';
    const nonce = 'qa-echo-ok-06';
    const sig = msgSignature(TOKEN, ts, nonce, echoCipher);

    const res = await app.api.inject({
      method: 'GET',
      url: `${WEBHOOK}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echoCipher)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echoPlain); // decrypted, not the ciphertext
  });
});

describe('WeChat PLAINTEXT mode — encodingAesKey absent (regression: old path intact)', () => {
  it('[edge] a raw XML POST (no <Encrypt>) still decrypt-free routes when encodingAesKey is ABSENT', async () => {
    // The new encrypted branch is gated on a configured EncodingAESKey. With it ABSENT,
    // the adapter must keep the PRIOR plaintext behavior: verify over the whole body,
    // parse the raw XML, route. This pins that the encrypted branch didn't regress it.
    const { app, sent } = wireAdapter(PLAINTEXT_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const ts = '1717398700';
    const nonce = 'qa-plain-07';
    const body = buildWeChatXml('@claude-opus 明文模式应当照常路由', '5005');
    const sig = computeSignature(TOKEN, ts, nonce, body); // over the WHOLE body

    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(SENDER_OPENID);
    expect(sent[0]?.content).toBe('已收到，处理中。');
  });

  it('[adversarial] a wrong body-signature in PLAINTEXT mode → 401 (the old verify gate still bites)', async () => {
    const { app, sent } = wireAdapter(PLAINTEXT_CONFIG);
    cleanups.push(app.close);
    await app.api.ready();

    const ts = '1717398800';
    const nonce = 'qa-plain-bad-08';
    const body = buildWeChatXml('@claude-opus 这条不该被接受', '5006');
    const badSig = computeSignature('the-wrong-token', ts, nonce, body);

    const res = await app.api.inject({
      method: 'POST',
      url: `${WEBHOOK}?msg_signature=${badSig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });
});
