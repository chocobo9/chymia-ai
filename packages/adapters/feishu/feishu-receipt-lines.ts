// packages/adapters/feishu/feishu-receipt-lines.ts
// 飞书 receipt 文案（纯数据，外部化 per CLAUDE.md §3.3）。
//
// L1 即时回执首选是 ❤️ reaction（addReaction）；当流式卡片打开时，这里的中性
// "收到/处理中" 文案用作卡片的 initial / 预览首行，让长耗时 agent 立刻有可见反馈。
// MVP 用通用文案（不按 agent 个性化，留后）；不是 placeholder，是真实可发的中文回执。

/**
 * 一组中性的 receipt 文案。无 "hello"/"test" 等占位串（CLAUDE.md §2.2）——
 * 都是真实可作为飞书机器人首条回执的中文短句。
 */
export const FEISHU_RECEIPT_LINES: readonly string[] = [
  '收到，正在处理…',
  '好的，马上看～',
  '在看了，稍等一下',
  '收到，整理一下思路',
  '了解，处理中…',
] as const;

/**
 * 按 seed 取一条回执文案（确定性，避免依赖 `Math.random`——脚本/测试环境受限）。
 * 调用方传入 `m.createTime`（NormalizedMessage 的毫秒时间戳）作为 seed，使同一条
 * 入站消息选到的回执稳定可复现。负数/非整数 seed 先归一化，永不越界。
 *
 * @param seed 任意数值种子（如入站消息的 createTime）。
 * @returns FEISHU_RECEIPT_LINES 中的一条非空文案。
 */
export function pickReceiptLine(seed: number): string {
  const len = FEISHU_RECEIPT_LINES.length;
  // |seed| 取整后对 len 取模——对 NaN/Infinity/负数也落到合法下标。
  const safeSeed = Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  const line = FEISHU_RECEIPT_LINES[safeSeed % len];
  // len 恒 > 0 且下标在界内，line 必有值；兜底保证返回非空 string（满足类型）。
  return line ?? FEISHU_RECEIPT_LINES[0] ?? '收到，正在处理…';
}
