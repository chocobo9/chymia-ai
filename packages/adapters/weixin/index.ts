// M14b personal-WeChat (iLink) adapter — subdir barrel. Named exports only.

export {
  createWeixinAdapter,
  WeixinAdapter,
  requestQrCode,
  checkQrStatus,
  type WeixinAdapterDeps,
  type SubmitPlatformMessage,
  type IngressResult,
  type AdapterLogger,
} from './weixin-adapter.js';

export {
  fetchQrCode,
  pollQrCodeStatus,
  getUpdates,
  sendText,
  parseUpdates,
  ILINK_BASE_URL,
  ERRCODE_SESSION_EXPIRED,
  type FetchFn,
  type QrCode,
  type QrStatus,
  type InboundText,
  type UpdatesResult,
} from './ilink-client.js';
