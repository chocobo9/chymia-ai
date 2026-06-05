// M-FEISHU 飞书/Lark adapter — subdir barrel. Named exports only.

export {
  createFeishuAdapter,
  FeishuAdapter,
  contentForIngress,
  type FeishuAdapterDeps,
  type SubmitPlatformMessage,
  type IngressResult,
  type AdapterLogger,
  type LarkChannelLike,
  type ChannelFactory,
  type FetchFn,
} from './feishu-adapter.js';

export {
  FEISHU_RECEIPT_LINES,
  pickReceiptLine,
} from './feishu-receipt-lines.js';

export { AsyncChunkQueue } from './async-chunk-queue.js';
