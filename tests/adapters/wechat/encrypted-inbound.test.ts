// M13 WeChat adapter — WeCom ENCRYPTED callback (WXBizMsgCrypt) dev happy-path.
//
// WeCom 自建应用「接收消息」AES-encrypts the callback; the adapter must decrypt the
// <Encrypt> blob before routing. Proves: (1) the crypt round-trips; (2) an
// ENCRYPTED inbound POST (valid msg_signature) is decrypted → routed → replied;
// (3) the GET echo is decrypted. Edge/adversarial (bad sig, bad padding, corpId
// mismatch) are the QA instance's.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import {
  createWeChatAdapter,
  deriveAesKeyIv,
  msgSignature,
  encryptWeComMessage,
  decryptWeComMessage,
  type OutboundSender,
} from '@choco/adapters/wechat';
import { replyScript, CLAUDE } from '../../api/helpers.js';
import { FakeAgentService } from '../../invocation/fake-agent-service.js';

const CORP_ID = 'ww1a2b3c4d5e6f7g8';
const SENDER_OPENID = 'oWxYz09876543210abcdEFghIJklmn';
const TOKEN = 'my-callback-token';
// A valid 43-char EncodingAESKey (32 random bytes, base64, trailing '=' stripped).
const ENCODING_AES_KEY = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '');

const CONFIG = {
  corpId: CORP_ID,
  agentId: '1000002',
  secret: 'fake-secret',
  token: TOKEN,
  apiBase: 'https://qyapi.weixin.qq.com/cgi-bin',
  encodingAesKey: ENCODING_AES_KEY,
} as const;

function buildWeChatXml(text: string, msgId: string): string {
  return (
    '<xml>' +
    '<ToUserName><![CDATA[gh_7f3a9c2e1b08]]></ToUserName>' +
    `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${text}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('WeCom crypt (WXBizMsgCrypt) — unit', () => {
  it('round-trips a message through encrypt → decrypt with the corpId intact', () => {
    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const plaintext = buildWeChatXml('你好，世界 🌏', '9001');
    const encrypted = encryptWeComMessage(plaintext, keyIv, CORP_ID);
    const { message, receivedCorpId } = decryptWeComMessage(encrypted, keyIv);
    expect(message).toBe(plaintext);
    expect(receivedCorpId).toBe(CORP_ID);
  });

  it('rejects an EncodingAESKey that does not decode to 32 bytes', () => {
    expect(() => deriveAesKeyIv('too-short')).toThrow(/32-byte/);
  });
});

describe('WeChat webhook — ENCRYPTED inbound (integration happy path)', () => {
  function injectApp(): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '已收到。')]) } });
  }

  it('decrypts an encrypted POST, routes it, and replies to the channel', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const sent: { channelId: string; content: string; agentId?: AgentId }[] = [];
    const fakeSender: OutboundSender = async (channelId, content, agentId) => {
      sent.push({ channelId, content, ...(agentId !== undefined ? { agentId } : {}) });
    };
    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: fakeSender,
    });
    await adapter.start();
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const inner = buildWeChatXml('@claude-opus 帮我看下这个', '3001');
    const encrypt = encryptWeComMessage(inner, keyIv, CORP_ID);
    const body = `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>`;
    const ts = '1700000001';
    const nonce = 'n0nce42';
    const sig = msgSignature(TOKEN, ts, nonce, encrypt);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/adapters/wechat/webhook?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`,
      headers: { 'content-type': 'text/xml' },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    // The encrypted message was decrypted, routed to the agent, and replied back.
    expect(sent).toHaveLength(1);
    expect(sent[0]?.channelId).toBe(SENDER_OPENID);
    expect(sent[0]?.content).toBe('已收到。');
  });

  it('returns the decrypted plaintext for the GET echo challenge', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const adapter = createWeChatAdapter({
      api: app.api,
      submitPlatformMessage: app.submitPlatformMessage,
      config: CONFIG,
      outboundSender: async () => {},
    });
    await adapter.start();
    await app.api.ready();

    const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);
    const echoPlain = 'echo-challenge-9931';
    const echoCipher = encryptWeComMessage(echoPlain, keyIv, CORP_ID);
    const ts = '1700000002';
    const nonce = 'echoNonce';
    const sig = msgSignature(TOKEN, ts, nonce, echoCipher);

    const res = await app.api.inject({
      method: 'GET',
      url: `/api/adapters/wechat/webhook?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echoCipher)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(echoPlain); // decrypted, not the ciphertext
  });
});
