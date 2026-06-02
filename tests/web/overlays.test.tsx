// @vitest-environment jsdom
//
// HAPPY / component tests (dev-authored) for the 4 Choco overlay surfaces:
// NotifInbox, WorkspacePanel (5 tabs), MonitorGrid, SettingsOverlay. These show
// each overlay OPENS from its shell control + renders its structure + the LIVE
// sections wire to real state/api. The QA (≠ this dev) authors the gating
// edge/adversarial coverage separately (§0.5.3).
//
// Idiom mirrors choco-design.edge.test.tsx: drive the full <App> with an injected
// fake ApiClient + a mock socket connector, plus seeded store state.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry, HealthPayload } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { EvidenceSearchResult } from '@choco/shared';
import { ROSTER, CLAUDE, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

/** Minimal mock socket (no network). */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }
  off(): this {
    return this;
  }
  emit(): this {
    return this;
  }
  disconnect(): this {
    return this;
  }
}

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

describe('NotifInbox (待你处理) — bell', () => {
  it('opens from the header bell and shows the honest empty state when no real signals', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    // No error agents + healthy /health → genuinely empty (never fabricated).
    expect(screen.getByTestId('notif-inbox-empty')).toHaveTextContent('没有待处理的事');
  });

  it('derives a real block item from an agent whose live status is error', async () => {
    await mountApp();
    // Drive a real error status into the agent store (the live signal).
    useAgentStore.setState({ statusById: { 'claude-opus': 'error' } });
    await userEvent.click(screen.getByTestId('bell-button'));
    const items = await screen.findAllByTestId('notif-item');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveAttribute('data-kind', 'block');
    // Bell badge reflects the derived count.
    expect(screen.getByTestId('bell-badge')).toHaveTextContent('1');
  });

  it('closes on scrim click', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('bell-button'));
    expect(screen.getByTestId('notif-inbox')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('notif-inbox-scrim'));
    expect(screen.queryByTestId('notif-inbox')).not.toBeInTheDocument();
  });
});

describe('WorkspacePanel (Workspace) — 5 tabs', () => {
  it('opens from the header panel button with the five tabs and the 开发 honest placeholder', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    for (const id of ['dev', 'mem', 'sched', 'tasks', 'comm']) {
      expect(screen.getByTestId(`wsp-tab-${id}`)).toBeInTheDocument();
    }
    // 开发 is honest-placeholder (no file/git backend).
    expect(screen.getByTestId('wsp-soon')).toBeInTheDocument();
  });

  it('switches to 记忆 and wires evidence search to the api (live results)', async () => {
    const evidence = vi.fn<() => Promise<EvidenceSearchResult>>().mockResolvedValue({
      items: [
        {
          anchor: 'decision:2026-05-30-api-framework',
          kind: 'decision',
          status: 'active',
          title: '采用 Fastify 作为 API 框架',
          summary: '相比 Express 更快、内置 schema 校验。',
          updatedAt: '2026-05-30T00:00:00.000Z',
        },
      ],
      meta: { effectiveMode: 'hybrid', degraded: false },
    });
    const { client } = await mountApp({ evidence });
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('wsp-tab-mem'));
    const input = screen.getByTestId('mem-search-input');
    await userEvent.type(input, 'API 框架{Enter}');
    const item = await screen.findByTestId('mem-item');
    expect(item).toHaveTextContent('采用 Fastify 作为 API 框架');
    expect(client.searchEvidence).toHaveBeenCalledWith('API 框架', { mode: 'hybrid', limit: 10 });
  });

  it('记忆 shows an honest empty state when the search returns no items', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    await userEvent.click(screen.getByTestId('wsp-tab-mem'));
    await userEvent.type(screen.getByTestId('mem-search-input'), '不存在的查询{Enter}');
    expect(await screen.findByTestId('mem-empty')).toBeInTheDocument();
  });

  it('调度 / 任务 / 社区 render clearly-marked honest placeholders (not fabricated data)', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    for (const id of ['sched', 'tasks', 'comm']) {
      await userEvent.click(screen.getByTestId(`wsp-tab-${id}`));
      const soon = screen.getByTestId('wsp-soon');
      expect(soon).toHaveTextContent('未接入');
    }
  });
});

describe('MonitorGrid (并行监看)', () => {
  it('opens from the grid button and renders one live pane per roster agent', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('monitor-button'));
    expect(screen.getByTestId('monitor-grid')).toBeInTheDocument();
    const cells = screen.getAllByTestId('mon-cell');
    expect(cells).toHaveLength(ROSTER.length);
    // ConnStrip is present (live /health-backed) and the quota is honest-placeholder.
    expect(screen.getByTestId('conn-strip')).toBeInTheDocument();
    expect(screen.getByTestId('monitor-quota-placeholder')).toHaveTextContent('未接入');
  });

  it('reflects live agent_status: a working agent renders data-status=working', async () => {
    await mountApp();
    useAgentStore.setState({ statusById: { 'claude-opus': 'working' } });
    await userEvent.click(screen.getByTestId('monitor-button'));
    const cell = screen
      .getAllByTestId('mon-cell')
      .find((c) => c.getAttribute('data-agent') === 'claude-opus');
    expect(cell).toBeDefined();
    expect(cell).toHaveAttribute('data-status', 'working');
  });

  it('ConnStrip 本地 API card reflects an ok /health probe', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('monitor-button'));
    const apiCard = await waitFor(() => {
      const card = screen
        .getAllByTestId('conn-card')
        .find((c) => c.getAttribute('data-conn') === 'api');
      expect(card).toHaveAttribute('data-status', 'ok');
      return card;
    });
    expect(within(apiCard as HTMLElement).getByText('畅通')).toBeInTheDocument();
  });
});

describe('SettingsOverlay (设置) — owner gear', () => {
  it('opens from the owner gear and shows the LIVE roster in 成员管理', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
    const cards = screen.getAllByTestId('settings-member-card');
    expect(cards).toHaveLength(ROSTER.length);
    // Member card derives from the real roster (accent/name), not the mock AGENTS.
    expect(cards[0]).toHaveAttribute('data-agent', CLAUDE);
  });

  it('运维监控 shows the live ConnStrip + a clearly-marked usage placeholder', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-ops'));
    expect(screen.getByTestId('settings-ops')).toBeInTheDocument();
    expect(screen.getByTestId('conn-strip')).toBeInTheDocument();
    expect(screen.getByTestId('settings-usage-placeholder')).toHaveTextContent('未接入');
  });

  it('unbacked panes (账户/Skill/MCP) render honest placeholders, not fabricated data', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByTestId('settings-nav-accounts'));
    expect(screen.getByTestId('settings-soon')).toHaveTextContent('未接入');
  });

  it('closes from the close button, leaving the core workspace intact underneath', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('owner-gear'));
    await userEvent.click(screen.getByLabelText('关闭设置'));
    expect(screen.queryByTestId('settings-overlay')).not.toBeInTheDocument();
    // Core workspace + its testids survive.
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
    expect(screen.getByTestId('thread-list')).toBeInTheDocument();
    expect(screen.getByTestId('agent-status')).toBeInTheDocument();
  });
});

describe('overlay exclusivity', () => {
  it('opening one overlay replaces / does not stack with another', async () => {
    await mountApp();
    await userEvent.click(screen.getByTestId('workspace-button'));
    expect(screen.getByTestId('workspace-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('monitor-button'));
    expect(screen.getByTestId('monitor-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-panel')).not.toBeInTheDocument();
  });
});
