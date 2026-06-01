// M13 WeChat adapter — xml-parser happy-path suite (DEV role).
// QA owns edge + adversarial coverage (malformed XML, injection, missing fields).
//
// Real WeChat MP/WeCom inbound envelopes with CDATA wrappers, real CJK content,
// real OpenId-shaped ids. Asserts text/image/event classification + epoch-s→ms.

import { describe, it, expect } from 'vitest';
import { parseWeChatXml } from '@clowder/adapters/wechat/xml-parser';

const OFFICIAL_ACCOUNT = 'gh_7f3a9c2e1b08';
const SENDER_OPENID = 'oABCdEf1234567890ghijklmnop';

describe('parseWeChatXml (happy path)', () => {
  it('parses a CDATA-wrapped CJK text message into a normalized record', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[帮我评估一下 Postgres 还是 SQLite 的读写性能]]></Content>' +
      '<MsgId>1234567890123456</MsgId>' +
      '</xml>';

    const parsed = parseWeChatXml(xml);

    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('text');
    expect(parsed?.toUser).toBe(OFFICIAL_ACCOUNT);
    expect(parsed?.fromUser).toBe(SENDER_OPENID);
    expect(parsed?.text).toBe('帮我评估一下 Postgres 还是 SQLite 的读写性能');
    expect(parsed?.messageId).toBe('1234567890123456');
  });

  it('converts CreateTime epoch seconds to epoch milliseconds', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[部署上线流程确认]]></Content>' +
      '<MsgId>1000000000000001</MsgId>' +
      '</xml>';

    const parsed = parseWeChatXml(xml);

    expect(parsed?.createdAt).toBe(1_700_000_000_000);
  });

  it('classifies an image message and surfaces PicUrl + MediaId', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000123</CreateTime>' +
      '<MsgType><![CDATA[image]]></MsgType>' +
      '<PicUrl><![CDATA[https://mmbiz.qpic.cn/mmbiz_jpg/abc123/0]]></PicUrl>' +
      '<MediaId><![CDATA[media-id-7f3a9c2e1b08]]></MediaId>' +
      '<MsgId>1000000000000002</MsgId>' +
      '</xml>';

    const parsed = parseWeChatXml(xml);

    expect(parsed?.kind).toBe('image');
    expect(parsed?.picUrl).toBe('https://mmbiz.qpic.cn/mmbiz_jpg/abc123/0');
    expect(parsed?.mediaId).toBe('media-id-7f3a9c2e1b08');
    expect(parsed?.text).toBe('');
  });

  it('classifies a subscribe event message and surfaces the Event name', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000200</CreateTime>' +
      '<MsgType><![CDATA[event]]></MsgType>' +
      '<Event><![CDATA[subscribe]]></Event>' +
      '</xml>';

    const parsed = parseWeChatXml(xml, () => 1_700_000_999_000);

    expect(parsed?.kind).toBe('event');
    expect(parsed?.event).toBe('subscribe');
    // No MsgId on events → synthesized from the injected clock.
    expect(parsed?.messageId).toBe('wechat-event-1700000999000');
  });
});
