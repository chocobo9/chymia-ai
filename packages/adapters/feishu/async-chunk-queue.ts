// packages/adapters/feishu/async-chunk-queue.ts
// 单生产者→单消费者的异步字符串队列，桥接 onTextDelta 回调与 channel.stream 的
// MarkdownStreamProducer：onTextDelta 到达时 push，submit 结束时 close；producer
// 侧 `for await (const chunk of queue) await ctrl.append(chunk)` 消费到 close。
//
// 为什么需要它：handleThreadMessage 的增量是 push 式回调（onTextDelta），而
// MarkdownStreamController 是 pull 式（producer 异步迭代）。这个有界缓冲把推转拉，
// 不丢序、不忙等；close 后迭代自然结束。
//
// Pattern from Clowder stream-merge.ts（异步 push/pull 桥接思路），此处自行重写。

/**
 * 一个 push/pull 字符串队列。`push` 入队一段增量，`close` 标记结束；它是
 * AsyncIterable<string>，`for await` 会按入队顺序产出每段，直到 close 后停止。
 * 单消费者：一个队列对应一张流式卡片（一个 agent）。
 */
export class AsyncChunkQueue implements AsyncIterable<string> {
  private readonly buffer: string[] = [];
  private closed = false;
  /** 消费者在缓冲为空时挂起的 resolver；push/close 唤醒它。 */
  private waiting: (() => void) | undefined;

  /** 入队一段文本增量。close 之后的 push 被忽略（不抛错——迟到的增量直接丢弃）。 */
  push(chunk: string): void {
    if (this.closed) return;
    this.buffer.push(chunk);
    this.wake();
  }

  /** 标记队列结束。唤醒等待中的消费者，使其迭代收尾。幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiting;
    if (w !== undefined) {
      this.waiting = undefined;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      if (this.buffer.length > 0) {
        // 一次清空已缓冲的增量，保持入队顺序。
        const chunk = this.buffer.shift();
        if (chunk !== undefined) yield chunk;
        continue;
      }
      if (this.closed) return;
      // 缓冲空且未关闭：挂起，等下一次 push/close 唤醒。
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}
