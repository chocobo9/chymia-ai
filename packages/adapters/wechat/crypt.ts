// packages/adapters/wechat/crypt.ts
// WeCom (企业微信) callback encryption — WXBizMsgCrypt.
//
// WeCom 自建应用「接收消息」ALWAYS AES-encrypts the callback: the POST body is
// `<xml><Encrypt>...</Encrypt></xml>` and the GET echostr is ciphertext.
// Verifying msg_signature alone is NOT enough — the <Encrypt> blob must be
// AES-256-CBC decrypted with the EncodingAESKey to recover the plaintext XML.
//
// Re-authored from the documented WXBizMsgCrypt algorithm (the same scheme
// Clowder's WeComAgentAdapter implements — pattern from
// reference/.../WeComAgentAdapter.ts, re-implemented here, not copied):
//   key = base64(EncodingAESKey + '='), 32 bytes ; iv = key[0:16]
//   msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join(''))
//   plaintext block (after AES decrypt + PKCS7 unpad):
//     [16 random bytes][4-byte BE msgLen][msgLen bytes XML][corpId bytes]

import crypto from 'node:crypto';

/** The 32-byte AES key + 16-byte IV derived from a 43-char EncodingAESKey. */
export interface AesKeyIv {
  readonly key: Buffer;
  readonly iv: Buffer;
}

/** Derive the AES key + IV from a WeCom EncodingAESKey (43 chars, no trailing '='). */
export function deriveAesKeyIv(encodingAesKey: string): AesKeyIv {
  const key = Buffer.from(`${encodingAesKey}=`, 'base64');
  if (key.length !== 32) {
    throw new Error(`invalid EncodingAESKey: expected 32-byte key, got ${key.length}`);
  }
  return { key, iv: key.subarray(0, 16) };
}

/** msg_signature = sha1(sort([token, timestamp, nonce, encrypt]).join('')). */
export function msgSignature(
  token: string,
  timestamp: string,
  nonce: string,
  encrypt: string,
): string {
  const joined = [token, timestamp, nonce, encrypt].sort().join('');
  return crypto.createHash('sha1').update(joined).digest('hex');
}

/** The plaintext message + the corpId embedded in a decrypted WeCom payload. */
export interface DecryptedWeCom {
  readonly message: string;
  readonly receivedCorpId: string;
}

/**
 * Decrypt a WeCom AES-256-CBC payload (base64) → { message (plaintext XML),
 * receivedCorpId }. Throws on a malformed/short payload (callers catch + 401).
 */
export function decryptWeComMessage(encryptedBase64: string, keyIv: AesKeyIv): DecryptedWeCom {
  const decipher = crypto.createDecipheriv('aes-256-cbc', keyIv.key, keyIv.iv);
  decipher.setAutoPadding(false); // we PKCS7-unpad by hand (WeCom layout)
  const decrypted = Buffer.concat([decipher.update(encryptedBase64, 'base64'), decipher.final()]);

  // PKCS7 unpad: the last byte is the pad length (1..16).
  const padLen = decrypted.length > 0 ? decrypted[decrypted.length - 1]! : 0;
  if (padLen < 1 || padLen > 16 || padLen > decrypted.length) {
    throw new Error('invalid PKCS7 padding in WeCom payload');
  }
  const raw = decrypted.subarray(0, decrypted.length - padLen);
  if (raw.length < 20) throw new Error('WeCom payload too short');

  // [16 random][4-byte BE msgLen][msg][corpId]
  const msgLen = raw.subarray(16, 20).readUInt32BE(0);
  if (20 + msgLen > raw.length) throw new Error('WeCom msgLen exceeds payload');
  const message = raw.subarray(20, 20 + msgLen).toString('utf-8');
  const receivedCorpId = raw.subarray(20 + msgLen).toString('utf-8');
  return { message, receivedCorpId };
}

/**
 * Encrypt a plaintext message into a WeCom base64 payload (inverse of
 * {@link decryptWeComMessage}). Used to build the GET-echo response and by tests
 * to produce a valid encrypted inbound body.
 */
export function encryptWeComMessage(plaintext: string, keyIv: AesKeyIv, corpId: string): string {
  const random = crypto.randomBytes(16);
  const msg = Buffer.from(plaintext, 'utf-8');
  const corp = Buffer.from(corpId, 'utf-8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msg.length, 0);
  const payload = Buffer.concat([random, lenBuf, msg, corp]);

  const blockSize = 16;
  const padLen = blockSize - (payload.length % blockSize) || blockSize;
  const padded = Buffer.concat([payload, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv('aes-256-cbc', keyIv.key, keyIv.iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}
