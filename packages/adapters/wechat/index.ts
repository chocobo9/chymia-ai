// M13 WeChat adapter — subdir barrel. Named exports only (no default export).
// The top-level packages/adapters/index.ts re-exports from here (orchestrator merges).

export {
  createWeChatAdapter,
  createWeComOutboundSender,
  bufferReply,
  computeSignature,
  WECHAT_BUFFER_CONSTANTS,
  type WeChatAdapterConfig,
  type WeChatAdapterDeps,
  type OutboundSender,
  type SubmitPlatformMessage,
  type IngressResult,
  type AdapterLogger,
} from './wechat-adapter.js';

export {
  parseWeChatXml,
  type WeChatInboundMessage,
  type WeChatInboundKind,
} from './xml-parser.js';

export {
  TokenManager,
  type TokenManagerConfig,
  type FetchFn,
} from './token-manager.js';

export {
  deriveAesKeyIv,
  msgSignature,
  decryptWeComMessage,
  encryptWeComMessage,
  type AesKeyIv,
  type DecryptedWeCom,
} from './crypt.js';
