// G6 QA — PlatformAdapter compile-level contract (edge + adversarial, dev≠QA).
//
// The PlatformAdapter interface (packages/shared/src/types/platform.ts) is the
// ONE contract M13 (WeChat) + M14 (Telegram) both implement. These tests are
// gated by the `tsc --noEmit` bar (root tsconfig includes tests/**): each
// `@ts-expect-error` asserts a NON-conforming shape MUST NOT compile — if the
// interface regresses (a method drops/loosens), the expected error disappears
// and tsc fails the gate. The runtime bodies keep vitest reporting executed,
// passing tests. A realistic conforming mock adapter proves the positive side.
// Authored independently from the design docs (§5.8 / §A10), NOT the impl.

import { describe, it, expect } from 'vitest';
import { createAgentId } from '@choco/shared';
import type {
  AgentId,
  PlatformAdapter,
  IncomingPlatformMessage,
} from '@choco/shared';

const CLAUDE: AgentId = createAgentId('claude-opus');

/**
 * A realistic conforming adapter (Telegram-flavoured long-poll). Implements the
 * full PlatformAdapter contract: readonly name, start/stop, sendMessage with the
 * optional agentId, onMessage taking an async IncomingPlatformMessage handler.
 */
class FakeTelegramAdapter implements PlatformAdapter {
  readonly name = 'telegram';
  private handler: ((m: IncomingPlatformMessage) => Promise<void>) | undefined;
  readonly sent: Array<{ channelId: string; content: string; agentId?: AgentId }> = [];
  private polling = false;

  async start(): Promise<void> {
    this.polling = true;
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.polling = false;
    return Promise.resolve();
  }

  async sendMessage(channelId: string, content: string, agentId?: AgentId): Promise<void> {
    this.sent.push({ channelId, content, ...(agentId !== undefined ? { agentId } : {}) });
    return Promise.resolve();
  }

  onMessage(handler: (message: IncomingPlatformMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Test affordance: simulate the platform delivering one inbound message. */
  async deliver(message: IncomingPlatformMessage): Promise<void> {
    if (this.handler !== undefined) await this.handler(message);
  }

  get isPolling(): boolean {
    return this.polling;
  }
}

describe('PlatformAdapter — a conforming adapter satisfies the contract', () => {
  it('a Telegram-shaped adapter implements the full interface and round-trips a message', async () => {
    const adapter: PlatformAdapter = new FakeTelegramAdapter();
    expect(adapter.name).toBe('telegram');

    await adapter.start();

    const received: IncomingPlatformMessage[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
      return Promise.resolve();
    });

    const inbound: IncomingPlatformMessage = {
      adapterName: 'telegram',
      channelId: '-1001987654321',
      platformUserId: '529384716',
      platformMessageId: 'tg-msg-7788',
      text: '@claude 请帮我评审这个 PR',
      receivedAt: 1_748_600_900_000,
    };
    await (adapter as FakeTelegramAdapter).deliver(inbound);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toContain('@claude');

    // sendMessage accepts the optional agentId 3rd arg (multi-agent attribution).
    await adapter.sendMessage('-1001987654321', '评审完成：建议拆分 router.route()。', CLAUDE);
    await adapter.sendMessage('-1001987654321', '（无 agentId 的纯文本回复也合法）');
    await adapter.stop();

    const sent = (adapter as FakeTelegramAdapter).sent;
    expect(sent).toHaveLength(2);
    expect(sent[0]?.agentId).toBe(CLAUDE);
    expect(sent[1]?.agentId).toBeUndefined();
  });

  it('the IncomingPlatformMessage handed to onMessage is the BUILT shape (text/receivedAt, not content/timestamp)', () => {
    // G6 reconciliation guard: the adapter contract is tied to the built M1 DTO.
    const msg: IncomingPlatformMessage = {
      adapterName: 'wechat',
      channelId: 'gh_a1b2c3d4e5f6',
      platformUserId: 'oABCdEf1234567890ghijklmnop',
      platformMessageId: 'wx-1',
      text: '@codex 跑一下测试',
      receivedAt: 1_748_600_900_000,
    };
    expect(msg.text).toBeDefined();
    expect(msg.receivedAt).toBeGreaterThan(0);
  });
});

describe('PlatformAdapter — non-conforming shapes MUST NOT compile (adversarial)', () => {
  /** Identity sink: forces its argument to be assignable to PlatformAdapter. */
  function expectAdapter(adapter: PlatformAdapter): PlatformAdapter {
    return adapter;
  }

  it('rejects an adapter missing the required `name`', () => {
    const result = expectAdapter(
      // @ts-expect-error — `name` is required on PlatformAdapter
      {
        start: async (): Promise<void> => Promise.resolve(),
        stop: async (): Promise<void> => Promise.resolve(),
        sendMessage: async (): Promise<void> => Promise.resolve(),
        onMessage: (): void => {},
      },
    );
    expect(result).toBeDefined();
  });

  it('rejects a non-string `name` (must be a string)', () => {
    const bad: PlatformAdapter = {
      // @ts-expect-error — `name` must be a string, not a number
      name: 42,
      start: async (): Promise<void> => Promise.resolve(),
      stop: async (): Promise<void> => Promise.resolve(),
      sendMessage: async (): Promise<void> => Promise.resolve(),
      onMessage: (): void => {},
    };
    expect(bad).toBeDefined();
  });

  it('rejects a sendMessage whose 1st param is the wrong type (channelId must be string)', () => {
    const bad: PlatformAdapter = {
      name: 'wechat',
      start: async (): Promise<void> => Promise.resolve(),
      stop: async (): Promise<void> => Promise.resolve(),
      // @ts-expect-error — channelId must be string; number widens the contract
      sendMessage: async (channelId: number): Promise<void> => {
        void channelId;
        return Promise.resolve();
      },
      onMessage: (): void => {},
    };
    expect(bad.name).toBe('wechat');
  });

  it('rejects an onMessage that is not a function', () => {
    const bad: PlatformAdapter = {
      name: 'telegram',
      start: async (): Promise<void> => Promise.resolve(),
      stop: async (): Promise<void> => Promise.resolve(),
      sendMessage: async (): Promise<void> => Promise.resolve(),
      // @ts-expect-error — onMessage must be a (handler) => void function, not a string
      onMessage: 'subscribe',
    };
    expect(bad.name).toBe('telegram');
  });

  it('rejects start() that is not a function (lifecycle methods MUST be callable)', () => {
    const bad: PlatformAdapter = {
      name: 'wechat',
      // @ts-expect-error — start must be a () => Promise<void> function, not null
      start: null,
      stop: async (): Promise<void> => Promise.resolve(),
      sendMessage: async (): Promise<void> => Promise.resolve(),
      onMessage: (): void => {},
    };
    expect(bad.name).toBe('wechat');
  });

  it('treats `name` as readonly (reassignment through the interface must not compile)', () => {
    const adapter: PlatformAdapter = new FakeTelegramAdapter();
    expect(adapter.name).toBe('telegram');
    function reassign(a: PlatformAdapter): void {
      // @ts-expect-error — `name` is readonly on PlatformAdapter
      a.name = 'spoofed';
    }
    // The `@ts-expect-error` is the gate (tsc fails if `name` ever loses readonly).
    // We never call reassign(), so no runtime mutation is asserted (TS readonly is
    // a compile-time guarantee only).
    expect(typeof reassign).toBe('function');
  });
});
