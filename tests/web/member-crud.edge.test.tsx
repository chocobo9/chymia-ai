// @vitest-environment jsdom
//
// 成员增删 (member add/delete) — web gate for the 添加成员 modal + the delete
// affordance in SettingsOverlay. Drives the FULL <App> with an injected fake
// ApiClient (spying createAgent / deleteAgent / listAgents) + a mock socket,
// mirroring member-edit.edge.test.tsx.
//
// dev=QA NOTE: authored in the same interactive session as the product code
// (not the §0.5.3 hand-off split) — called out honestly.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%. Real ids/identities only.

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
import { ROSTER, CLAUDE, makeThread } from './fixtures.js';

class MockSocket implements SocketLike {
  on(): this {
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

/** A runtime-added member (removable) — a second Claude identity, the reviewer. */
const REVIEWER: AgentRosterEntry = {
  id: 'claude-review',
  name: '审查布偶',
  displayName: 'Claude (Reviewer)',
  clientId: 'anthropic',
  color: { primary: '#dc2626', secondary: '#f87171' },
  mentionPatterns: ['@review', '@审查'],
  strengths: ['威胁建模', '测试设计'],
  status: 'idle',
  removable: true,
};

function makeClient(roster: readonly AgentRosterEntry[], rosterAfter?: readonly AgentRosterEntry[]): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  const listAgents = vi.spyOn(client, 'listAgents');
  listAgents.mockResolvedValueOnce(roster);
  listAgents.mockResolvedValue(rosterAfter ?? roster);
  vi.spyOn(client, 'listThreads').mockResolvedValue([makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue([]);
  vi.spyOn(client, 'createAgent').mockResolvedValue(REVIEWER);
  vi.spyOn(client, 'deleteAgent').mockResolvedValue(undefined);
  return client;
}

async function mountApp(roster: readonly AgentRosterEntry[], rosterAfter?: readonly AgentRosterEntry[]): Promise<ApiClient> {
  const connector: SocketConnector = () => new MockSocket();
  const client = makeClient(roster, rosterAfter);
  render(<App client={client} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  return client;
}

async function openSettings(): Promise<void> {
  await userEvent.click(screen.getByTestId('owner-gear'));
  expect(screen.getByTestId('settings-overlay')).toBeInTheDocument();
}

beforeEach(() => {
  useChatStore.setState({ threads: [], messagesByThread: {}, streamingByThread: {}, activeThreadId: null });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('添加成员 modal (create)', () => {
  it('[happy] filling the form + 添加 POSTs the normalized member, then refetches the roster', async () => {
    const client = await mountApp(ROSTER, [...ROSTER, REVIEWER]);
    await openSettings();
    await userEvent.click(screen.getByTestId('member-create-open'));
    await waitFor(() => expect(screen.getByTestId('member-create-modal')).toBeInTheDocument());

    await userEvent.type(screen.getByTestId('member-create-id'), 'claude-review');
    await userEvent.type(screen.getByTestId('member-create-name'), '审查布偶');
    await userEvent.type(screen.getByTestId('member-create-model'), 'claude-opus-4-6');
    await userEvent.type(screen.getByTestId('member-create-mentions'), 'review 审查'); // space-separated
    await userEvent.click(screen.getByTestId('member-create-save'));

    await waitFor(() => expect(client.createAgent).toHaveBeenCalledTimes(1));
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'claude-review',
        name: '审查布偶',
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4-6',
        mentionPatterns: ['@review', '@审查'], // @-prefixed by the composer
      }),
    );
    // Roster refetched (mount + post-create) and the modal closed.
    expect(vi.mocked(client.listAgents).mock.calls.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => expect(screen.queryByTestId('member-create-modal')).not.toBeInTheDocument());
  });

  it('[edge] 添加 stays disabled until the required fields (id/name/model/@mention) are filled', async () => {
    await mountApp(ROSTER);
    await openSettings();
    await userEvent.click(screen.getByTestId('member-create-open'));
    expect(screen.getByTestId('member-create-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('member-create-id'), 'claude-review');
    await userEvent.type(screen.getByTestId('member-create-name'), '审查布偶');
    // Still missing model + mention → still disabled.
    expect(screen.getByTestId('member-create-save')).toBeDisabled();
  });
});

describe('删除成员 (delete)', () => {
  it('[edge] a runtime-added member shows 删除 and clicking it (confirmed) calls deleteAgent', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const client = await mountApp([...ROSTER, REVIEWER]);
    await openSettings();
    const card = screen
      .getAllByTestId('settings-member-card')
      .find((c) => c.getAttribute('data-agent') === 'claude-review');
    expect(card).toBeDefined();
    await userEvent.click(within(card as HTMLElement).getByTestId('member-delete'));
    await waitFor(() => expect(client.deleteAgent).toHaveBeenCalledWith('claude-review'));
  });

  it('[adv] a BASE member exposes NO 删除 affordance (only runtime-added are deletable)', async () => {
    await mountApp([...ROSTER, REVIEWER]);
    await openSettings();
    const baseCard = screen
      .getAllByTestId('settings-member-card')
      .find((c) => c.getAttribute('data-agent') === CLAUDE);
    expect(within(baseCard as HTMLElement).queryByTestId('member-delete')).not.toBeInTheDocument();
  });

  it('[adv] cancelling the confirm dialog does NOT call deleteAgent', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const client = await mountApp([...ROSTER, REVIEWER]);
    await openSettings();
    const card = screen
      .getAllByTestId('settings-member-card')
      .find((c) => c.getAttribute('data-agent') === 'claude-review');
    await userEvent.click(within(card as HTMLElement).getByTestId('member-delete'));
    expect(client.deleteAgent).not.toHaveBeenCalled();
  });
});
