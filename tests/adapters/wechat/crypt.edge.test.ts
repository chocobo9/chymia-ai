// M13 WeChat (WeCom) crypt — WXBizMsgCrypt EDGE + ADVERSARIAL gate (QA role).
//
// Authored by the INDEPENDENT QA instance (dev≠QA, CLAUDE §0.5.3): the dev shipped
// the crypt round-trip happy path in encrypted-inbound.test.ts. This file gates the
// dark corners of crypt.ts:
//   • deriveAesKeyIv: rejects keys that do NOT decode to exactly 32 bytes (short /
//     long / non-base64), and derives iv = key[0:16] for a valid 43-char key.
//   • decryptWeComMessage adversarial inputs: garbage base64, a buffer with bad
//     PKCS7 padding, a too-short payload, and a 4-byte msgLen that exceeds the
//     payload — each must THROW (callers map a throw → 401, never route garbage).
//   • round-trip fidelity for empty / CJK+emoji / very-long messages, and a corpId
//     with multibyte chars (the trailing-bytes slice must survive UTF-8).
//   • msgSignature: order-independent over its four params (the WeCom SORT join) and
//     deterministic for the same inputs.
//
// We build raw AES-CBC ciphertexts by hand (same key/iv crypt.ts derives) so we can
// forge a valid-AES-but-bad-WeCom-layout blob — exercising the post-decrypt layout
// guards, not just a corrupt-ciphertext rejection. No product code modified (tests/).
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  deriveAesKeyIv,
  msgSignature,
  encryptWeComMessage,
  decryptWeComMessage,
  type AesKeyIv,
} from '@choco/adapters/wechat';

// A valid 43-char EncodingAESKey: 32 bytes base64, trailing '=' stripped (the WeCom
// shape — base64(key + '=') is the 32-byte AES key). The dev fixture's trick.
const ENCODING_AES_KEY = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '');
const CORP_ID = 'ww8f1a2b3c4d5e6f70';
const TOKEN = 'choco-wecom-callback-7Hq2';

/**
 * Forge an AES-256-CBC ciphertext (base64) from RAW post-unpad bytes, applying the
 * same WeCom PKCS7 pad crypt.ts expects. Lets a test produce a blob that AES-decrypts
 * cleanly but carries a deliberately malformed WeCom layout (e.g. an inflated msgLen).
 */
function forgeCipher(raw: Buffer, keyIv: AesKeyIv): string {
  const blockSize = 16;
  const padLen = blockSize - (raw.length % blockSize) || blockSize;
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyIv.key, keyIv.iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

/** Build a WeCom raw payload [16 random][4-byte BE msgLen][msg][corpId] with an
 * EXPLICIT msgLen (so a test can set msgLen != msg.length to forge an overflow). */
function rawPayload(msg: Buffer, corp: Buffer, msgLen: number): Buffer {
  const random = crypto.randomBytes(16);
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgLen, 0);
  return Buffer.concat([random, lenBuf, msg, corp]);
}

describe('deriveAesKeyIv — key-length validation (edge + adversarial)', () => {
  it('[edge] derives a 32-byte key and a 16-byte iv = key[0:16] for a valid 43-char key', () => {
    // Arrange + Act
    const { key, iv } = deriveAesKeyIv(ENCODING_AES_KEY);

    // Assert — 32-byte AES-256 key, iv is the first 16 bytes of the key (WeCom rule).
    expect(key.length).toBe(32);
    expect(iv.length).toBe(16);
    expect(iv.equals(key.subarray(0, 16))).toBe(true);
  });

  it('[adversarial] throws on a key that decodes to FEWER than 32 bytes', () => {
    // 'too-short' + '=' base64-decodes to far fewer than 32 bytes.
    expect(() => deriveAesKeyIv('too-short')).toThrow(/32-byte/);
  });

  it('[adversarial] throws on a key that decodes to MORE than 32 bytes', () => {
    // A 60-byte buffer → base64 (no trailing '='), then '=' is appended by derive →
    // decodes to > 32 bytes, which must be rejected (over-long, not just short).
    const tooLong = crypto.randomBytes(60).toString('base64').replace(/=+$/, '');
    expect(() => deriveAesKeyIv(tooLong)).toThrow(/32-byte/);
  });

  it('[adversarial] throws on an empty key (decodes to 0 bytes)', () => {
    expect(() => deriveAesKeyIv('')).toThrow(/32-byte/);
  });
});

describe('decryptWeComMessage — malformed payload rejection (adversarial)', () => {
  const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);

  it('[adversarial] throws on garbage that is not a valid ciphertext length', () => {
    // Random bytes that do not form a whole number of AES blocks → cipher.final throws.
    const garbage = crypto.randomBytes(17).toString('base64');
    expect(() => decryptWeComMessage(garbage, keyIv)).toThrow();
  });

  it('[adversarial] throws when the decrypted block has invalid PKCS7 padding', () => {
    // Forge a ciphertext whose last plaintext byte is 0x00 (an illegal pad length:
    // PKCS7 pad must be 1..16). We AES-encrypt an exact-block buffer ending in 0x00
    // WITHOUT applying valid padding, so the unpad guard rejects it.
    const oneBlock = Buffer.alloc(16, 0); // last byte 0x00 → padLen 0 → invalid
    const cipher = crypto.createCipheriv('aes-256-cbc', keyIv.key, keyIv.iv);
    cipher.setAutoPadding(false);
    const blob = Buffer.concat([cipher.update(oneBlock), cipher.final()]).toString('base64');
    expect(() => decryptWeComMessage(blob, keyIv)).toThrow(/padding/);
  });

  it('[adversarial] throws when the unpadded payload is shorter than the 20-byte header', () => {
    // A validly-padded payload of only 4 raw bytes (< the 16 random + 4 len header).
    const blob = forgeCipher(Buffer.from([1, 2, 3, 4]), keyIv);
    expect(() => decryptWeComMessage(blob, keyIv)).toThrow(/too short/);
  });

  it('[adversarial] throws when the 4-byte msgLen exceeds the available payload', () => {
    // A well-formed header but msgLen claims far more bytes than the payload holds —
    // the layout guard (20 + msgLen > raw.length) must reject it, not over-read.
    const msg = Buffer.from('短', 'utf-8');
    const corp = Buffer.from(CORP_ID, 'utf-8');
    const inflated = msg.length + corp.length + 9999; // msgLen way past the real msg
    const blob = forgeCipher(rawPayload(msg, corp, inflated), keyIv);
    expect(() => decryptWeComMessage(blob, keyIv)).toThrow(/exceeds/);
  });

  it('[adversarial] throws on an empty base64 string (no blocks to decrypt)', () => {
    expect(() => decryptWeComMessage('', keyIv)).toThrow();
  });
});

describe('decryptWeComMessage / encryptWeComMessage — round-trip fidelity (edge)', () => {
  const keyIv = deriveAesKeyIv(ENCODING_AES_KEY);

  it('[edge] round-trips an EMPTY message (msgLen 0) with the corpId intact', () => {
    const encrypted = encryptWeComMessage('', keyIv, CORP_ID);
    const { message, receivedCorpId } = decryptWeComMessage(encrypted, keyIv);
    expect(message).toBe('');
    expect(receivedCorpId).toBe(CORP_ID);
  });

  it('[edge] round-trips a CJK + emoji message without corrupting multibyte runs', () => {
    const plaintext = '审批通过了 ✅ 准备发布 🚀，注意灰度。';
    const encrypted = encryptWeComMessage(plaintext, keyIv, CORP_ID);
    const { message, receivedCorpId } = decryptWeComMessage(encrypted, keyIv);
    expect(message).toBe(plaintext);
    expect(receivedCorpId).toBe(CORP_ID);
  });

  it('[edge] round-trips a very long message (> several AES blocks) losslessly', () => {
    // ~12 KB of mixed content forces many blocks + a non-trivial msgLen.
    const plaintext = '巡检日志条目：服务正常。'.repeat(500);
    const encrypted = encryptWeComMessage(plaintext, keyIv, CORP_ID);
    const { message } = decryptWeComMessage(encrypted, keyIv);
    expect(message).toBe(plaintext);
    expect(message.length).toBe(plaintext.length);
  });

  it('[edge] preserves a multibyte corpId (trailing slice decoded as UTF-8)', () => {
    // The corpId is the trailing slice after the message; a multibyte tail must
    // survive the subarray→toString('utf-8') boundary.
    const corp = 'ww企业标识_42';
    const plaintext = '<xml><Content><![CDATA[在岗]]></Content></xml>';
    const encrypted = encryptWeComMessage(plaintext, keyIv, corp);
    const { message, receivedCorpId } = decryptWeComMessage(encrypted, keyIv);
    expect(message).toBe(plaintext);
    expect(receivedCorpId).toBe(corp);
  });

  it('[edge] two encryptions of the SAME plaintext differ (random 16-byte prefix) yet both decrypt back', () => {
    // The 16 random bytes make the ciphertext non-deterministic (no leakage of
    // equal plaintexts), but both must decrypt to the original.
    const plaintext = '同样的明文加密两次密文应不同';
    const a = encryptWeComMessage(plaintext, keyIv, CORP_ID);
    const b = encryptWeComMessage(plaintext, keyIv, CORP_ID);
    expect(a).not.toBe(b);
    expect(decryptWeComMessage(a, keyIv).message).toBe(plaintext);
    expect(decryptWeComMessage(b, keyIv).message).toBe(plaintext);
  });
});

describe('msgSignature — sorted-join SHA1 (edge + adversarial)', () => {
  it('[edge] is a 40-char lowercase hex SHA1 digest', () => {
    const sig = msgSignature(TOKEN, '1717398000', 'nonce-7c', 'cipher-blob-AABB');
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
  });

  it('[edge] is deterministic for identical inputs', () => {
    const a = msgSignature(TOKEN, '1717398000', 'nonce-7c', 'cipher-blob-AABB');
    const b = msgSignature(TOKEN, '1717398000', 'nonce-7c', 'cipher-blob-AABB');
    expect(a).toBe(b);
  });

  it('[adversarial] is order-independent across its four params (WeCom SORTS before hashing)', () => {
    // The four values are SORTED then joined, so permuting which argument slot a value
    // sits in yields the SAME digest. We feed the four literal strings in two different
    // positional orders and expect an identical signature.
    const v1 = 'choco-wecom-callback-7Hq2';
    const v2 = '1717398000';
    const v3 = 'qa-nonce-04f7';
    const v4 = 'aGVsbG8gd2Vjb20gY2lwaGVy'; // a base64-looking Encrypt blob
    const ordered = msgSignature(v1, v2, v3, v4);
    const permuted = msgSignature(v4, v3, v2, v1);
    expect(permuted).toBe(ordered);
  });

  it('[adversarial] a single changed byte in the Encrypt blob flips the signature', () => {
    const base = msgSignature(TOKEN, '1717398000', 'nonce-7c', 'cipher-blob-AABB');
    const tampered = msgSignature(TOKEN, '1717398000', 'nonce-7c', 'cipher-blob-AABC');
    expect(tampered).not.toBe(base);
  });
});
