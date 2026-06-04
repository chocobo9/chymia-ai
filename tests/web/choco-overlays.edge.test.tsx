// @vitest-environment jsdom
//
// QA GATING tests (Part A) for the Choco overlay surfaces — NotifInbox,
// WorkspacePanel (5 tabs + 记忆 live evidence search), SettingsOverlay (+ ConnStrip
// via 运维监控). dev≠QA (§0.5.3): authored by a DIFFERENT instance than the one
// that wrote packages/web/src/components/overlays/*. NO product code modified.
//
// Idiom (build-App-with-fakes, from g8-incremental / choco-design.edge): drive the
// FULL <App> with an injected fake ApiClient (stubbed listAgents/listThreads/
// getMessages/searchEvidence/health) + a mock socket connector that can replay
// agent_status frames, plus directly-seeded Zustand store state.
//
// Distribution of THIS file's tests (gating mandate happy ≤50% / edge ≥30% /
// adv ≥20%) — each `it` is tagged in its title with [happy]/[edge]/[adv].
//   happy : open each overlay, switch tabs, live evidence renders, roster lists.
//   edge  : every close path (scrim/button/Esc), exclusivity, core-intact-under,
//           empty/loading/degraded states, live status transitions, recolored
//           roster, nav switching, derived inbox items, health-down derivation.
//   adv   : no design mock string/number leaks as live data (128k/500k quota, 267
//           文档, upstream 降级, FILES/SCHED/issues counts), search throws → honest
//           error (no crash), reconciled deferred-affordance assertion.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry, HealthPayload } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { AgentId, AgentState, EvidenceItem, EvidenceSearchResult } from '@choco/shared';
import { ROSTER, CLAUDE, CODEX, GEMINI, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

/** Mock socket that replays server frames into the live store wiring. */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, listener?: (...args: unknown[]) => void): this {
    if (listener === undefined) {
      this.handlers.delete(event);
      return this;
    }
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((l) => l !== listener),
    );
    return this;
  }
  emit(): this {
    return this;
  }
  disconnect(): this {
    return this;
  }
  fire(event: string, payload: unknown): void {
    for (const l of this.handlers.get(event) ?? []) l(payload);
  }
}

/** An `agent_status` (AgentState) frame for one agent (drives applyAgentStatus). */
function statusFrame(id: AgentId, status: AgentState['status']): AgentState {
  return { id, status, currentThreadId: 'thread_todo_api', lastActiveAt: 100 };
}

/** A realistic evidence result item (real decision prose, never placeholder). */
const FASTIFY_DECISION: EvidenceItem = {
  anchor: 'decision:2026-05-30-api-framework',
  kind: 'decision',
  status: 'active',
  title: '采用 Fastify 作为 API 框架',
  summary: '相比 Express 更快、内置 JSON schema 校验，与 M8 路由层契合。',
  updatedAt: '2026-05-30T00:00:00.000Z',
};

interface SetupOptions {
  readonly roster?: readonly AgentRosterEntry[];
  readonly health?: () => Promise<HealthPayload>;
  readonly evidence?: () => Promise<EvidenceSearchResult>;
}

function makeClient(opts: SetupOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(opts.roster ?? ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue([makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue([]);
  vi.spyOn(client, 'createThread').mockResolvedValue(makeThread());
  vi.spyOn(client, 'sendMessage').mockResolvedValue({
    userMessage: makeUserMessage(),
    replies: [makeAgentReply()],
  });
  vi.spyOn(client, 'health').mockImplementation(
    opts.health ??
      (() => Promise.resolve({ status: 'ok', uptimeMs: 12_000, timestamp: 1_780_000_000_000 })),
  );
  vi.spyOn(client, 'searchEvidence').mockImplementation(
    opts.evidence ??
      (() => Promise.resolve({ items: [], meta: { effectiveMode: 'hybrid', degraded: false } })),
  );
  return client;
}

async function mountApp(opts: SetupOptions = {}): Promise<{ socket: MockSocket; client: ApiClient }> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  const client = makeClient(opts);
  render(<App client={client} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  return { socket, client };
}

/** Assert the core workspace shell is mounted + intact (used under every overlay). */
function expectCoreIntact(): void {
  expect(screen.getByTestId('app-root')).toBeInTheDocument();
  expect(screen.getByTestId('thread-list')).toBeInTheDocument();
  expect(screen.getByTestId('agent-status')).toBeInTheDocument();
  expect(screen.getByTestId('chat-input')).toBeInTheDocument();
}

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: [], statusById: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ============================================================================
 * 1. Open each overlay from its control + close paths (scrim / button / Esc).
 * ========================================================================== */
describe('overlay open/close paths', () => {
  it('[happy] each overlay opens from its dedicated shell control', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('bell-button')); // toggle closed
    expect(screen.queryByTestId('notif-inbox')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('owner-gear'));
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
  });

  it('[edge] NotifInbox closes via scrim click', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('notif-inbox-scrim'));
    expect(screen.queryByTestId('notif-inbox')).not.toBeInTheDocument();
    expectCoreIntact();
  });

  it('[edge] WorkspacePanel closes via scrim click (outside the docked panel)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('workspace-panel-scrim'));
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
  });

  it('[edge] WorkspacePanel does NOT close when clicking inside the panel body (stopPropagation)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('workspace-panel-body'));
    // A click on the docked panel itself must not bubble to the scrim's onClose.
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
  });

  it('[edge] SettingsOverlay closes via the 返回工作台 nav-footer button', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
    await userEvent.click(screen.getByText('← 返回工作台'));
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument();
    expectCoreIntact();
  });

  it('[edge] Escape closes the NotifInbox', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('notif-inbox')).not.toBeInTheDocument();
  });

  it('[edge] Escape closes the WorkspacePanel and SettingsOverlay', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument();
    expectCoreIntact();
  });
});

/* ============================================================================
 * 2. Exclusivity + core workspace intact underneath.
 * ========================================================================== */
describe('overlay exclusivity + core intact', () => {
  it('[edge] opening a second overlay replaces the first (one surface at a time)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    // bell → workspace
    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('notif-inbox')).not.toBeInTheDocument();
    // workspace → settings
    await userEvent.click(screen.getByTestId('owner-gear'));
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
  });

  it('[edge] the core workspace (threads/status/composer) stays mounted under every overlay', async () => {
    await mountApp();
    for (const open of ['bell-button', 'workspace-button', 'owner-gear']) {
      await userEvent.click(screen.getByTestId(open));
      expectCoreIntact();
      // The left-column controls (new-thread / owner-gear) are reachable underneath.
      expect(screen.getByTestId('new-thread-button')).toBeInTheDocument();
      expect(screen.getByTestId('owner-gear')).toBeInTheDocument();
    }
  });

  it('[adv] only ONE overlay dialog is ever present in the DOM at once', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('bell-button'));
    const overlayTestids = [
      'notif-inbox',
      'workspace-panel',
      'settings-overlay',
    ].filter((id) => screen.queryByTestId(id) !== null);
    expect(overlayTestids).toEqual(['notif-inbox']);
  });
});

/* ============================================================================
 * 3. WorkspacePanel — 5 tabs each render their body.
 * ========================================================================== */
describe('WorkspacePanel — 5 tabs', () => {
  it('[happy] all five tabs are present and switch their body', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    for (const id of ['dev', 'mem', 'sched', 'tasks', 'comm'] as const) {
      expect(screen.getByTestId(`wsp-tab-${id}`)).toBeInTheDocument();
    }
    // 开发 (default) is an honest placeholder.
    expect(screen.getByTestId('wsp-soon')).toHaveTextContent('未接入');
    // 记忆 → live evidence search surface (idle state).
    await userEvent.click(screen.getByTestId('wsp-tab-mem'));
    expect(screen.getByTestId('wsp-memory')).toBeInTheDocument();
    expect(screen.getByTestId('mem-idle')).toBeInTheDocument();
    // back to a placeholder tab.
    await userEvent.click(screen.getByTestId('wsp-tab-sched'));
    expect(screen.getByTestId('wsp-soon')).toBeInTheDocument();
    expect(screen.queryByTestId('wsp-memory')).not.toBeInTheDocument();
  });

  it('[edge] the active tab carries aria-selected; the rest do not', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('wsp-tab-tasks'));
    expect(screen.getByTestId('wsp-tab-tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('wsp-tab-dev')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('wsp-tab-comm')).toHaveAttribute('aria-selected', 'false');
  });
});

/* ============================================================================
 * 4. 记忆 evidence search (LIVE) — results / empty / loading / degraded / error.
 * ========================================================================== */
describe('记忆 evidence search (live)', () => {
  async function openMemory(opts: SetupOptions = {}): Promise<{ client: ApiClient }> {
    const { client } = await mountApp(opts);
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('wsp-tab-mem'));
    return { client };
  }

  it('[happy] typing a query calls client.searchEvidence and renders the real result', async () => {
    const evidence = vi
      .fn<() => Promise<EvidenceSearchResult>>()
      .mockResolvedValue({ items: [FASTIFY_DECISION], meta: { effectiveMode: 'hybrid', degraded: false } });
    const { client } = await openMemory({ evidence });
    await userEvent.type(screen.getByTestId('mem-search-input'), 'API 框架决策{Enter}');
    const item = await screen.findByTestId('mem-item');
    expect(item).toHaveTextContent('采用 Fastify 作为 API 框架');
    expect(item).toHaveTextContent('相比 Express 更快');
    expect(client.searchEvidence).toHaveBeenCalledWith('API 框架决策', { mode: 'hybrid', limit: 10 });
    // 命中 stat reflects the real result count (1), never a fabricated number.
    expect(screen.getByText('命中').nextElementSibling).toHaveTextContent('1');
  });

  it('[edge] an empty result set renders the honest empty state, not zero fabricated rows', async () => {
    await openMemory();
    await userEvent.type(screen.getByTestId('mem-search-input'), '从未记录过的主题{Enter}');
    const empty = await screen.findByTestId('mem-empty');
    expect(empty).toHaveTextContent('没有匹配');
    expect(screen.queryByTestId('mem-item')).not.toBeInTheDocument();
  });

  it('[edge] meta.degraded → a degraded badge is shown (lexical fallback)', async () => {
    const evidence = vi.fn<() => Promise<EvidenceSearchResult>>().mockResolvedValue({
      items: [FASTIFY_DECISION],
      meta: { effectiveMode: 'lexical', degraded: true, degradeReason: 'embeddings unavailable' },
    });
    await openMemory({ evidence });
    await userEvent.type(screen.getByTestId('mem-search-input'), 'fastify{Enter}');
    expect(await screen.findByTestId('mem-degraded')).toHaveTextContent('已降级为词法检索');
  });

  it('[edge] an in-flight search shows the loading state before the result resolves', async () => {
    let resolveSearch: ((r: EvidenceSearchResult) => void) | undefined;
    const evidence = vi
      .fn<() => Promise<EvidenceSearchResult>>()
      .mockImplementation(() => new Promise<EvidenceSearchResult>((res) => (resolveSearch = res)));
    await openMemory({ evidence });
    await userEvent.type(screen.getByTestId('mem-search-input'), '检索中的查询{Enter}');
    expect(await screen.findByTestId('mem-loading')).toHaveTextContent('检索中');
    act(() => resolveSearch?.({ items: [FASTIFY_DECISION], meta: { effectiveMode: 'hybrid', degraded: false } }));
    expect(await screen.findByTestId('mem-item')).toBeInTheDocument();
    expect(screen.queryByTestId('mem-loading')).not.toBeInTheDocument();
  });

  it('[adv] when searchEvidence throws, an honest error state shows and the app does not crash', async () => {
    const evidence = vi
      .fn<() => Promise<EvidenceSearchResult>>()
      .mockRejectedValue(new Error('evidence index unavailable (500)'));
    await openMemory({ evidence });
    await userEvent.type(screen.getByTestId('mem-search-input'), '触发后端错误{Enter}');
    const err = await screen.findByTestId('mem-error');
    expect(err).toHaveTextContent('检索出错');
    expect(err).toHaveTextContent('evidence index unavailable');
    expect(err).toHaveAttribute('role', 'alert');
    // Overlay + core shell survive the rejected search.
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    expectCoreIntact();
  });

  it('[adv] a whitespace-only query does NOT hit the backend (returns to idle)', async () => {
    const { client } = await openMemory();
    await userEvent.type(screen.getByTestId('mem-search-input'), '   {Enter}');
    expect(screen.getByTestId('mem-idle')).toBeInTheDocument();
    expect(client.searchEvidence).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * 5. ConnStrip / health — ok / down / loading (via SettingsOverlay 运维监控).
 * ========================================================================== */
describe('ConnStrip / health', () => {
  function apiCard(): HTMLElement | undefined {
    return screen.getAllByTestId('conn-card').find((c) => c.getAttribute('data-conn') === 'api');
  }

  it('[happy] an ok /health probe paints the 本地 API card ok (畅通)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    await waitFor(() => expect(apiCard()).toHaveAttribute('data-status', 'ok'));
    expect(within(apiCard() as HTMLElement).getByText('畅通')).toBeInTheDocument();
  });

  it('[edge] a down /health probe (throws) paints the card warn (不可达)', async () => {
    await mountApp({ health: () => Promise.reject(new Error('ECONNREFUSED')) });
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    await waitFor(() => expect(apiCard()).toHaveAttribute('data-status', 'warn'));
    expect(within(apiCard() as HTMLElement).getByText('不可达')).toBeInTheDocument();
  });

  it('[edge] while the probe is in flight the card shows the loading (探测中) state', async () => {
    // health never resolves → stays in loading.
    await mountApp({ health: () => new Promise<HealthPayload>(() => {}) });
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    await waitFor(() => expect(apiCard()).toHaveAttribute('data-status', 'unknown'));
    expect(within(apiCard() as HTMLElement).getByText('探测中')).toBeInTheDocument();
  });

  it('[adv] 上游模型 card is always the honest 未接入 unknown, never the design 降级', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    const upstream = screen
      .getAllByTestId('conn-card')
      .find((c) => c.getAttribute('data-conn') === 'upstream');
    expect(upstream).toHaveAttribute('data-status', 'unknown');
    expect(within(upstream as HTMLElement).getByText('未接入')).toBeInTheDocument();
    expect(within(upstream as HTMLElement).queryByText('降级')).not.toBeInTheDocument();
  });
});

/* ============================================================================
 * 7. NotifInbox derivation — block / system / honest-empty + resolve.
 * ========================================================================== */
describe('NotifInbox derivation (待你处理)', () => {
  it('[happy] no real signals → the honest empty state and a zero (hidden) bell badge', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox-empty')).toHaveTextContent('没有待处理的事');
    expect(screen.queryByTestId('notif-item')).not.toBeInTheDocument();
    expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument();
  });

  it('[edge] an agent in error status derives exactly one block item + bumps the bell badge', async () => {
    const { socket } = await mountApp();
    act(() => socket.fire('agent_status', statusFrame(GEMINI, 'error')));
    await waitFor(() => expect(screen.getByTestId('bell-badge')).toHaveTextContent('1'));
    await userEvent.click(screen.getByTestId('bell-button'));
    const items = screen.getAllByTestId('notif-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-kind', 'block');
    // The block item names the blocked agent (short name from the live roster).
    expect(items[0]).toHaveTextContent('卡住了');
  });

  it('[edge] a down /health probe derives a system item in the inbox', async () => {
    await mountApp({ health: () => Promise.reject(new Error('health down')) });
    await userEvent.click(screen.getByTestId('bell-button'));
    const sys = await screen.findByTestId('notif-item');
    expect(sys).toHaveAttribute('data-kind', 'system');
    expect(sys).toHaveTextContent('本地 API 不可达');
  });

  it('[edge] two error agents + a down probe derive three items (2 block + 1 system)', async () => {
    const { socket } = await mountApp({ health: () => Promise.reject(new Error('down')) });
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'error')));
    act(() => socket.fire('agent_status', statusFrame(CODEX, 'error')));
    await userEvent.click(screen.getByTestId('bell-button'));
    const items = await screen.findAllByTestId('notif-item');
    const kinds = items.map((i) => i.getAttribute('data-kind')).sort();
    expect(kinds).toEqual(['block', 'block', 'system']);
  });

  it('[adv] resolving (dismiss) an item removes it and decrements the count to empty', async () => {
    const { socket } = await mountApp();
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'error')));
    await waitFor(() => expect(screen.getByTestId('bell-badge')).toHaveTextContent('1'));
    await userEvent.click(screen.getByTestId('bell-button'));
    const item = screen.getByTestId('notif-item');
    // The item's action button resolves it.
    await userEvent.click(within(item).getByRole('button'));
    expect(screen.queryByTestId('notif-item')).not.toBeInTheDocument();
    expect(screen.getByTestId('notif-inbox-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument();
  });

  it('[adv] the inbox never fabricates 决策 / PR 审批 rows — only block/system kinds appear', async () => {
    const { socket } = await mountApp();
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'error')));
    await userEvent.click(screen.getByTestId('bell-button'));
    const items = await screen.findAllByTestId('notif-item');
    for (const it of items) {
      expect(['block', 'system']).toContain(it.getAttribute('data-kind'));
    }
    // The design's mock kinds (decision/review) must NOT surface without a backend.
    expect(items.some((i) => i.getAttribute('data-kind') === 'decision')).toBe(false);
    expect(items.some((i) => i.getAttribute('data-kind') === 'review')).toBe(false);
  });
});

/* ============================================================================
 * 8. Settings — LIVE roster (no hardcoded AGENTS) + nav switching.
 * ========================================================================== */
describe('SettingsOverlay (设置)', () => {
  it('[happy] 成员管理 lists the live roster (one card per agent, accent + name from roster)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    const cards = screen.getAllByTestId('settings-member-card');
    expect(cards).toHaveLength(ROSTER.length);
    expect(cards[0]).toHaveAttribute('data-agent', CLAUDE);
    // Accent comes from roster color.primary (#6366f1 = rgb(99,102,241)).
    expect(cards[0]).toHaveStyle({ '--ac': '#6366f1' });
    expect(within(cards[0]).getByText('Claude')).toBeInTheDocument();
  });

  it('[edge] nav switching renders each pane head + body (members → ops → appearance)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    expect(screen.getByTestId('settings-ops')).toBeInTheDocument();
    expect(screen.getByTestId('conn-strip')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('settings-nav-appearance'));
    expect(screen.getByTestId('settings-appearance')).toBeInTheDocument();
    expect(screen.getByTestId('theme-choco')).toBeInTheDocument();
    // Back to members.
    await userEvent.click(screen.getByTestId('settings-nav-members'));
    expect(screen.getByTestId('settings-members')).toBeInTheDocument();
  });

  it('[adv] a RECOLORED + RENAMED roster reflects in 成员管理 (proves no hardcoded AGENTS)', async () => {
    const RECOLORED: readonly AgentRosterEntry[] = [
      {
        id: 'gemini-pro',
        name: '暹罗猫',
        displayName: 'Hermes (Flash)',
        clientId: 'google',
        color: { primary: '#e11d48', secondary: '#fb7185' },
        mentionPatterns: ['@hermes'],
        strengths: ['研究调研', '方案对比'],
        status: 'working',
      },
    ];
    await mountApp({ roster: RECOLORED });
    await userEvent.click(screen.getByTestId('owner-gear'));
    const cards = screen.getAllByTestId('settings-member-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveAttribute('data-agent', 'gemini-pro');
    expect(within(cards[0]).getByText('Hermes')).toBeInTheDocument();
    // Recolored accent flows through (#e11d48 = rgb(225,29,72)), not a fixed indigo.
    expect(cards[0]).toHaveStyle({ '--ac': '#e11d48' });
    // The OLD fixture name must not leak.
    expect(within(cards[0]).queryByText('Claude')).not.toBeInTheDocument();
  });

  it('[edge] 运维监控 reflects a live working status pushed over the socket', async () => {
    const { socket } = await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    act(() => socket.fire('agent_status', statusFrame(CODEX, 'working')));
    await waitFor(() => {
      const row = within(screen.getByTestId('settings-ops'))
        .getAllByText(/Codex/)[0]
        .closest('.usage-row');
      expect(row).toHaveAttribute('data-status', 'working');
    });
  });

  it('[adv] the STILL-unbacked settings panes show 未接入 placeholders, never fabricated data', async () => {
    const { client } = await mountApp();
    // 账户与密钥 is now a REAL backed pane (BYOK accounts) — stub its load so the
    // pane reaches a stable empty-state (asserted in its own test below).
    vi.spyOn(client, 'listAccounts').mockResolvedValue([]);
    await userEvent.click(screen.getByTestId('owner-gear'));
    // Skill / MCP / 规则SOP / 账户 are now wired to real backends. 能力市场 / 通知 have
    // no backend yet, so they stay honest 未接入 placeholders.
    for (const nav of ['market', 'notif'] as const) {
      await userEvent.click(screen.getByTestId(`settings-nav-${nav}`));
      expect(screen.getByTestId('settings-soon')).toHaveTextContent('未接入');
    }
    // 运维监控 usage bars: honest placeholder, never the design mock numbers.
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    expect(screen.getByTestId('settings-usage-placeholder')).toHaveTextContent('未接入');
    expect(within(screen.getByTestId('settings-ops')).queryByText(/128k/)).not.toBeInTheDocument();
  });

  it('[adv] 账户与密钥 renders the real AccountsPane (not a 未接入 placeholder)', async () => {
    const { client } = await mountApp();
    vi.spyOn(client, 'listAccounts').mockResolvedValue([]);
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-accounts'));
    expect(screen.getByTestId('settings-accounts')).toBeInTheDocument();
    expect(await screen.findByTestId('accounts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-soon')).not.toBeInTheDocument();
  });
});

/* ============================================================================
 * 9. Adversarial — no design-mock data leaks across the workspace overlays.
 * ========================================================================== */
describe('no fabricated data leaks (adversarial)', () => {
  it('[adv] WorkspacePanel 调度/任务/社区 show 未接入, never the design SCHED/issues rows', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    for (const id of ['sched', 'tasks', 'comm'] as const) {
      await userEvent.click(screen.getByTestId(`wsp-tab-${id}`));
      const soon = screen.getByTestId('wsp-soon');
      expect(soon).toHaveTextContent('未接入');
    }
    // The 记忆 命中 stat must be 0 before any search (never the design "267 文档").
    await userEvent.click(screen.getByTestId('wsp-tab-mem'));
    const panel = screen.getByTestId('workspace-panel');
    expect(within(panel).queryByText('267')).not.toBeInTheDocument();
    expect(within(panel).getByText('命中').nextElementSibling).toHaveTextContent('0');
  });

  it('[adv] the bell badge count is derived (real signals only), never a hardcoded number', async () => {
    // Empty signals → NO badge at all (0 is hidden, not rendered as "0").
    const { socket } = await mountApp();
    expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument();
    // One real error → badge "1"; clear it → badge gone again.
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'error')));
    await waitFor(() => expect(screen.getByTestId('bell-badge')).toHaveTextContent('1'));
    act(() => socket.fire('agent_status', statusFrame(CLAUDE, 'idle')));
    await waitFor(() => expect(screen.queryByTestId('bell-badge')).not.toBeInTheDocument());
  });
});

/* ============================================================================
 * 10. Re-validate the dev's reconciled assertion: bell/panel are now REAL
 *     triggers (enabled), while the still-deferred StatusBar affordances stay
 *     inert. (Mirrors choco-design.edge "shell controls" but as an overlay gate.)
 * ========================================================================== */
describe('reconciled deferred-affordance assertion (re-validated)', () => {
  it('[adv] bell/panel/owner-gear are enabled real triggers; deferred StatusBar bits stay inert', async () => {
    await mountApp();
    // All four overlay triggers are enabled (no longer disabled placeholders).
    expect(screen.getByTestId('bell-button')).toBeEnabled();
    expect(screen.getByTestId('workspace-button')).toBeEnabled();
    expect(screen.getByTestId('owner-gear')).toBeEnabled();
    // And each actually opens its overlay (reachability, not just enabled-ness).
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    // The WorkspacePanel global search is now ENABLED (routes to evidence search);
    // the lock affordance is still deferred (disabled).
    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByLabelText('搜索 Workspace')).toBeEnabled();
    expect(screen.getByLabelText('锁定面板')).toBeDisabled();
  });
});
