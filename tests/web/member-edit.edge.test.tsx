// @vitest-environment jsdom
//
// M-MEMBER QA GATING suite (web) — edge + adversarial coverage for the 编辑成员
// modal in SettingsOverlay.
//
// dev≠QA (CLAUDE.md §0.5.3): authored by a DIFFERENT instance than the one that
// wrote packages/web/src/components/overlays/SettingsOverlay.tsx + lib/api.ts. NO
// product code is modified — only tests.
//
// Idiom (build-App-with-fakes, mirrors choco-overlays.edge.test.tsx): drive the
// FULL <App> with an injected fake ApiClient (spying listAgents / updateAgent) +
// a mock socket connector, plus seeded store state. The modal opens from the
// 成员管理 card's 编辑成员 button, PATCHes via client.updateAgent, then refetches
// the roster via client.listAgents() and closes on success.
//
// Distribution (gating mandate happy ≤50% / edge ≥30% / adv ≥20%) — each `it` is
// tagged [happy]/[edge]/[adv] in its title.
//
// Real inputs only: real agent ids + real role/strength prose (审查员 · 安全与测试).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
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
  /** Roster the first listAgents() resolves to (defaults to ROSTER). */
  readonly roster?: readonly AgentRosterEntry[];
  /** Roster a refetch (the post-save listAgents call) resolves to. */
  readonly rosterAfterSave?: readonly AgentRosterEntry[];
  /** updateAgent override (e.g. a rejection for the failure path). */
  readonly updateAgent?: (id: string, patch: unknown) => Promise<AgentRosterEntry>;
}

function makeClient(opts: SetupOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  const listAgents = vi.spyOn(client, 'listAgents');
  // First call (mount) → roster; a later call (post-save refetch) → rosterAfterSave.
  listAgents.mockResolvedValueOnce(opts.roster ?? ROSTER);
  listAgents.mockResolvedValue(opts.rosterAfterSave ?? opts.roster ?? ROSTER);

  vi.spyOn(client, 'listThreads').mockResolvedValue([makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue([]);
  vi.spyOn(client, 'createThread').mockResolvedValue(makeThread());
  vi.spyOn(client, 'sendMessage').mockResolvedValue({
    userMessage: makeUserMessage(),
    replies: [makeAgentReply()],
  });
  vi.spyOn(client, 'health').mockResolvedValue({
    status: 'ok',
    uptimeMs: 12_000,
    timestamp: 1_780_000_000_000,
  });
  vi.spyOn(client, 'searchEvidence').mockResolvedValue({
    items: [],
    meta: { effectiveMode: 'hybrid', degraded: false },
  });

  if (opts.updateAgent !== undefined) {
    vi.spyOn(client, 'updateAgent').mockImplementation(opts.updateAgent);
  } else {
    // Default: echo the patch merged onto the claude roster entry.
    vi.spyOn(client, 'updateAgent').mockImplementation((id, patch) =>
      Promise.resolve({ ...ROSTER[0], id, ...(patch as Partial<AgentRosterEntry>) }),
    );
  }
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

/** Open the settings overlay → 成员管理, then open the claude member's edit modal. */
async function openClaudeEditModal(): Promise<void> {
  await userEvent.click(screen.getByTestId('owner-gear'));
  expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
  const claudeCard = screen
    .getAllByTestId('settings-member-card')
    .find((c) => c.getAttribute('data-agent') === CLAUDE);
  expect(claudeCard).toBeDefined();
  await userEvent.click(within(claudeCard as HTMLElement).getByTestId('member-edit-open'));
  await waitFor(() => expect(screen.getByTestId('member-edit-modal')).toBeInTheDocument());
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
 * 1. Open / structure — the modal and its testids resolve.
 * ========================================================================== */
describe('编辑成员 modal — open & structure', () => {
  it('[happy] the 编辑成员 button opens the modal pre-filled with the member fields', async () => {
    await mountApp();
    await openClaudeEditModal();
    // The five editable fields are present and seeded from the roster entry.
    expect(screen.getByTestId('member-edit-name')).toHaveValue('布偶猫');
    expect(screen.getByTestId('member-edit-displayName')).toHaveValue('Claude (Opus)');
    expect(screen.getByTestId('member-edit-strengths')).toHaveValue('架构设计、代码实现、重构');
    expect(screen.getByTestId('member-edit-color')).toHaveValue('#6366f1');
    expect(screen.getByTestId('member-edit-save')).toBeInTheDocument();
    // KNOWN GAP (in scope, not a bug): roleDescription is not in the roster payload,
    // so the field starts empty ("留空则不修改当前角色").
    expect(screen.getByTestId('member-edit-role')).toHaveValue('');
  });

  it('[edge] the 取消 / close button dismisses the modal without calling updateAgent', async () => {
    const { client } = await mountApp();
    await openClaudeEditModal();
    await userEvent.click(screen.getByLabelText('关闭编辑'));
    await waitFor(() => expect(screen.queryByTestId('member-edit-modal')).not.toBeInTheDocument());
    // The settings overlay is still open underneath; no PATCH fired.
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
});

/* ============================================================================
 * 2. Save (happy + refetch) — the right id + patch, roster refetched, card updates.
 * ========================================================================== */
describe('编辑成员 modal — save', () => {
  it('[happy] save calls updateAgent with the member id + the edited patch, then closes', async () => {
    const { client } = await mountApp();
    await openClaudeEditModal();

    // Edit the role + strengths to a security-reviewer identity.
    await userEvent.type(
      screen.getByTestId('member-edit-role'),
      '审查员 · 安全与测试，负责威胁建模与覆盖把关。',
    );
    const strengths = screen.getByTestId('member-edit-strengths');
    await userEvent.clear(strengths);
    await userEvent.type(strengths, '威胁建模、测试设计');

    await userEvent.click(screen.getByTestId('member-edit-save'));

    await waitFor(() => expect(client.updateAgent).toHaveBeenCalledTimes(1));
    const [id, patch] = (client.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe(CLAUDE);
    expect(patch.roleDescription).toBe('审查员 · 安全与测试，负责威胁建模与覆盖把关。');
    expect(patch.strengths).toEqual(['威胁建模', '测试设计']);
    // The unedited display fields ride along (the modal sends the current values).
    expect(patch.displayName).toBe('Claude (Opus)');
    // Modal closes on success.
    await waitFor(() => expect(screen.queryByTestId('member-edit-modal')).not.toBeInTheDocument());
  });

  it('[edge] on success the roster is refetched and the card reflects the change', async () => {
    // The post-save refetch returns a roster where claude was renamed + recolored.
    const RENAMED: readonly AgentRosterEntry[] = [
      {
        ...ROSTER[0],
        displayName: 'Athena (Opus)',
        strengths: ['威胁建模', '测试设计'],
        color: { primary: '#dc2626', secondary: '#f87171' },
      },
      ROSTER[1],
      ROSTER[2],
    ];
    const { client } = await mountApp({ rosterAfterSave: RENAMED });
    await openClaudeEditModal();

    await userEvent.click(screen.getByTestId('member-edit-save'));

    // listAgents called twice total: once at mount, once on the post-save refetch.
    await waitFor(() => expect(client.listAgents).toHaveBeenCalledTimes(2));
    // The claude card now shows the refetched short name + new strengths chip.
    await waitFor(() => {
      const card = screen
        .getAllByTestId('settings-member-card')
        .find((c) => c.getAttribute('data-agent') === CLAUDE) as HTMLElement;
      expect(within(card).getByText('Athena')).toBeInTheDocument();
      expect(within(card).getByText('威胁建模')).toBeInTheDocument();
    });
    // The stale name must be gone.
    const card = screen
      .getAllByTestId('settings-member-card')
      .find((c) => c.getAttribute('data-agent') === CLAUDE) as HTMLElement;
    expect(within(card).queryByText('Claude')).not.toBeInTheDocument();
  });

  it('[edge] an empty 角色描述 field is NOT sent (roleDescription omitted from the patch)', async () => {
    const { client } = await mountApp();
    await openClaudeEditModal();
    // Leave 角色描述 empty (the default); just save.
    await userEvent.click(screen.getByTestId('member-edit-save'));
    await waitFor(() => expect(client.updateAgent).toHaveBeenCalledTimes(1));
    const [, patch] = (client.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // An empty role means "leave the existing role" → the key is absent.
    expect(patch).not.toHaveProperty('roleDescription');
    // The other fields are still sent.
    expect(patch.displayName).toBe('Claude (Opus)');
    expect(patch.color).toEqual({ primary: '#6366f1', secondary: '#818cf8' });
  });

  it('[adv] a whitespace-only 角色描述 is trimmed away and NOT sent', async () => {
    const { client } = await mountApp();
    await openClaudeEditModal();
    await userEvent.type(screen.getByTestId('member-edit-role'), '   ');
    await userEvent.click(screen.getByTestId('member-edit-save'));
    await waitFor(() => expect(client.updateAgent).toHaveBeenCalledTimes(1));
    const [, patch] = (client.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(patch).not.toHaveProperty('roleDescription');
  });

  it('[adv] save preserves the existing secondary color while editing only the primary', async () => {
    const { client } = await mountApp();
    await openClaudeEditModal();
    await userEvent.click(screen.getByTestId('member-edit-save'));
    await waitFor(() => expect(client.updateAgent).toHaveBeenCalledTimes(1));
    const [, patch] = (client.updateAgent as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // color.secondary is carried from the roster entry (only primary is editable).
    expect(patch.color).toEqual({ primary: '#6366f1', secondary: '#818cf8' });
  });
});

/* ============================================================================
 * 3. Failure — a rejected PATCH surfaces an inline error, modal stays, no crash.
 * ========================================================================== */
describe('编辑成员 modal — failure path', () => {
  it('[adv] a rejected updateAgent shows member-edit-error, keeps the modal open, and does not crash', async () => {
    const { client } = await mountApp({
      updateAgent: () => Promise.reject(new Error('保存失败：400 invalid_body')),
    });
    await openClaudeEditModal();

    await userEvent.click(screen.getByTestId('member-edit-save'));

    const err = await screen.findByTestId('member-edit-error');
    expect(err).toHaveTextContent('保存失败：400 invalid_body');
    expect(err).toHaveAttribute('role', 'alert');
    // The modal stays open (so the operator can correct + retry).
    expect(screen.getByTestId('member-edit-modal')).toBeInTheDocument();
    // The app shell + settings overlay survive the rejection.
    expect(screen.getByTestId('app-root')).toBeInTheDocument();
    expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
    // A failed save must NOT refetch the roster (listAgents stays at the mount call).
    expect(client.listAgents).toHaveBeenCalledTimes(1);
  });

  it('[edge] after a failure the operator can retry and a subsequent success closes the modal', async () => {
    let attempt = 0;
    const { client } = await mountApp({
      updateAgent: (id, patch) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error('暂时性后端错误 (503)'));
        return Promise.resolve({ ...ROSTER[0], id, ...(patch as Partial<AgentRosterEntry>) });
      },
    });
    await openClaudeEditModal();

    // First save → fails, error shown, modal open.
    await userEvent.click(screen.getByTestId('member-edit-save'));
    expect(await screen.findByTestId('member-edit-error')).toBeInTheDocument();
    expect(screen.getByTestId('member-edit-modal')).toBeInTheDocument();

    // Retry → succeeds, error clears, modal closes.
    await userEvent.click(screen.getByTestId('member-edit-save'));
    await waitFor(() => expect(client.updateAgent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('member-edit-modal')).not.toBeInTheDocument());
  });
});
