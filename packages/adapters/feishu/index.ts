// M-FEISHU 飞书/Lark adapter — subdir barrel. Named exports only.

export {
  createFeishuAdapter,
  FeishuAdapter,
  type FeishuAdapterDeps,
  type SubmitPlatformMessage,
  type IngressResult,
  type AdapterLogger,
} from './feishu-adapter.js';

export {
  FeishuTokenCache,
  sendFeishuText,
  parseFeishuEvent,
  type FetchFn,
  type FeishuInbound,
} from './feishu-client.js';
