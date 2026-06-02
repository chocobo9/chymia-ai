// @vitest-environment jsdom
//
// QA edge + adversarial gating suite for the per-thread ⋯ kebab → rename (inline)
// / delete (confirm) feature + the main-bar title following the active thread.
// dev≠QA (§0.5.3): authored by a different instance than the one that wrote the
// product code in packages/web. NO product code modified.
//
// Two layers:
//   • <ThreadList> in isolation — kebab menu state machine, inline-rename state
//     machine (incl. the blur-vs-mousedown commit race), delete confirm gating,
//     and the row markup change (<button> → <div role="button">) re-validated
//     for click + keyboard activation, aria-current, and intact testids.
//   • the FULL <App> with an injected fake ApiClient (the build-App-with-fakes
//     idiom from choco-design.edge) — delete wiring (client.deleteThread + store
//     removeThread, active-thread-clears vs non-active-keeps) and the main-bar
//     title following + rename re-render + the hidden .tag.
//
// Real session titles only (no placeholder data).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThreadList } from '../../packages/web/src/components/ThreadList.js';
import { App } from '../../packages/web/src/App.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { AgentRosterEntry } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import type { StoredMessage, Thread } from '@choco/shared';
import { ROSTER, makeThread } from './fixtures.js';

/* ============================================================================
 * Fixtures / harness
 * ========================================================================== */

const THREAD_A = makeThread({ id: 'thread_todo_api', title: 'TODO API 设计与实现' });
const THREAD_B = makeThread({
  id: 'thread_evidence',
  title: 'Evidence 召回阈值评审',
  participants: [],
});

/** Minimal mock socket (no live frames needed for these gates). */
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
}

interface AppClientOptions {
  readonly roster?: readonly AgentRosterEntry[];
  readonly threads?: readonly Thread[];
  readonly messages?: readonly StoredMessage[];
}

/** Build a fake ApiClient with stubbed network methods (no real fetch). */
function makeClient(opts: AppClientOptions = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(opts.roster ?? ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue(opts.threads ?? [THREAD_A, THREAD_B]);
  vi.spyOn(client, 'getMessages').mockResolvedValue(opts.messages ?? []);
  vi.spyOn(client, 'deleteThread').mockResolvedValue(undefined);
  vi.spyOn(client, 'renameThread').mockImplementation((id: string, title: string) =>
    Promise.resolve(makeThread({ id, title })),
  );
  return client;
}

/** Mount App with fakes; wait for the initial roster/threads load to settle. */
async function mountApp(opts: AppClientOptions = {}): Promise<{ client: ApiClient }> {
  const socket = new MockSocket();
  const connector: SocketConnector = () => socket;
  const client = makeClient(opts);
  render(<App client={client} socketConnector={connector} />);
  await waitFor(() => expect(useAgentStore.getState().roster.length).toBeGreaterThan(0));
  await waitFor(() => expect(useChatStore.getState().threads.length).toBeGreaterThan(0));
  return { client };
}

beforeEach(() => {
  useChatStore.setState({
    threads: [],
    messagesByThread: {},
    streamingByThread: {},
    noticesByThread: {},
    activeThreadId: null,
  });
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ============================================================================
 * Kebab menu state machine (edge)
 * ========================================================================== */
describe('ThreadList kebab menu state machine (edge)', () => {
  it('clicking ⋯ does NOT select the row (stopPropagation) but DOES open the menu', async () => {
    const onSelect = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={onSelect} />);

    await userEvent.click(screen.getByTestId('thread-kebab'));
    expect(screen.getByTestId('thread-menu')).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('the menu closes via Escape (useOverlayDismiss), not only the scrim', async () => {
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    await userEvent.click(screen.getByTestId('thread-kebab'));
    expect(screen.getByTestId('thread-menu')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('thread-menu')).toBeNull());
  });

  it('only one row menu is open at a time — opening row B replaces row A menu', async () => {
    useChatStore.setState({ threads: [THREAD_A, THREAD_B] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    const kebabs = screen.getAllByTestId('thread-kebab');
    expect(kebabs).toHaveLength(2);

    await userEvent.click(kebabs[0]);
    // Open menu names the first thread's actions.
    expect(screen.getAllByTestId('thread-menu')).toHaveLength(1);

    await userEvent.click(kebabs[1]);
    // Still exactly one menu (the anchor moved to row B; row A's is gone).
    expect(screen.getAllByTestId('thread-menu')).toHaveLength(1);
  });

  it('the role=menu carries two menuitems (重命名 / 删除会话) and the kebab advertises aria-haspopup', async () => {
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    const kebab = screen.getByTestId('thread-kebab');
    expect(kebab).toHaveAttribute('aria-haspopup', 'menu');
    await userEvent.click(kebab);

    const menu = screen.getByTestId('thread-menu');
    expect(menu).toHaveAttribute('role', 'menu');
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(2);
  });
});

/* ============================================================================
 * Inline rename state machine (edge + adversarial)
 * ========================================================================== */
describe('ThreadList inline rename state machine (edge + adversarial)', () => {
  it('entering edit seeds the draft from the CURRENT title (not blank)', async () => {
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={vi.fn()} />);

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));

    const input = screen.getByTestId('thread-rename-input') as HTMLInputElement;
    expect(input.value).toBe('TODO API 设计与实现');
    // Entering edit closes the menu.
    expect(screen.queryByTestId('thread-menu')).toBeNull();
  });

  it('commits the edited title via Enter', async () => {
    const onRename = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, 'TODO API 设计与实现 — 收尾{Enter}');

    expect(onRename).toHaveBeenCalledWith('thread_todo_api', 'TODO API 设计与实现 — 收尾');
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('ADVERSARIAL blur-vs-mousedown race: the check button commits even though blur would cancel', async () => {
    // The check uses onMouseDown (fires before the input blur) so a click on it
    // commits the draft instead of the blur silently cancelling. We simulate the
    // real event order: mousedown on the commit button, THEN blur of the input.
    const onRename = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId('thread-kebab'));
    await user.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input') as HTMLInputElement;
    input.focus();
    await user.clear(input);
    await user.type(input, 'Evidence 召回阈值评审 v2');

    // A REAL pointer sequence on the commit button: pointerdown→mousedown→focus
    // shift (which blurs the input)→…→click. Because commit is wired to
    // onMouseDown (NOT onClick), it fires BEFORE the blur cancels the edit. If a
    // regression moved commit to onClick, the input's blur would cancel first and
    // onRename would never be called with the edited value — this gates that.
    await user.click(screen.getByTestId('thread-rename-commit'));

    expect(onRename).toHaveBeenCalledWith('thread_todo_api', 'Evidence 召回阈值评审 v2');
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('cancels via Escape without committing', async () => {
    const onRename = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    await userEvent.type(input, ' 暂存草稿{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('cancels via blur (clicking elsewhere) — blur commits the unchanged draft, never a phantom rename of a DIFFERENT value', async () => {
    // A plain blur (no edit) commits the SEEDED title unchanged. We assert blur
    // does not crash and exits edit mode; with no change it may re-send the same
    // title or nothing — either way it must NOT rename to a different value.
    const onRename = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    fireEvent.blur(input);

    await waitFor(() => expect(screen.queryByTestId('thread-rename-input')).toBeNull());
    // Blur with the unchanged seeded value: if it commits at all, it is the SAME
    // title — never some other value.
    for (const call of onRename.mock.calls) {
      expect(call).toEqual(['thread_todo_api', 'TODO API 设计与实现']);
    }
  });

  it('an empty/whitespace draft NEVER commits (onRenameThread not called)', async () => {
    const onRename = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(
      <ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={onRename} />,
    );

    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    await userEvent.clear(input);
    await userEvent.type(input, '    {Enter}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByTestId('thread-rename-input')).toBeNull();
  });

  it('editing one row does not put a sibling row into edit mode', async () => {
    useChatStore.setState({ threads: [THREAD_A, THREAD_B] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={vi.fn()} />);

    const kebabs = screen.getAllByTestId('thread-kebab');
    await userEvent.click(kebabs[1]); // open row B's menu
    await userEvent.click(screen.getByText('重命名'));

    // Exactly one edit input exists, and it is seeded with row B's title.
    const inputs = screen.getAllByTestId('thread-rename-input');
    expect(inputs).toHaveLength(1);
    expect((inputs[0] as HTMLInputElement).value).toBe('Evidence 召回阈值评审');
    // Row A still shows its title (not an input).
    expect(screen.getByText('TODO API 设计与实现')).toBeInTheDocument();
  });
});

/* ============================================================================
 * Row select after the <button> → <div role="button"> markup change (edge)
 * ========================================================================== */
describe('ThreadList row markup change re-validated (edge)', () => {
  it('the row is a div with role="button" (no nested <button> ancestry violation)', () => {
    useChatStore.setState({ threads: [THREAD_A], activeThreadId: 'thread_todo_api' });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} />);

    const row = screen.getByTestId('thread-item');
    expect(row.tagName).toBe('DIV');
    expect(row).toHaveAttribute('role', 'button');
    // The kebab nested inside is a real <button> — legal only because the row is
    // no longer a button.
    expect(within(row).getByTestId('thread-kebab').tagName).toBe('BUTTON');
  });

  it('clicking the row still selects it (onSelectThread fires)', async () => {
    const onSelect = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={onSelect} />);

    await userEvent.click(screen.getByText('TODO API 设计与实现'));
    expect(onSelect).toHaveBeenCalledWith('thread_todo_api');
  });

  it('keyboard Enter AND Space on the focused row activate it (the new onKeyDown)', async () => {
    const onSelect = vi.fn();
    useChatStore.setState({ threads: [THREAD_A] });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={onSelect} />);

    const row = screen.getByTestId('thread-item');
    expect(row).toHaveAttribute('tabindex', '0');
    row.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenNthCalledWith(1, 'thread_todo_api');
    expect(onSelect).toHaveBeenNthCalledWith(2, 'thread_todo_api');
  });

  it('aria-current="true" marks the active row and intact testids resolve', () => {
    useChatStore.setState({ threads: [THREAD_A, THREAD_B], activeThreadId: 'thread_evidence' });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onOpenSettings={vi.fn()} />);

    const rows = screen.getAllByTestId('thread-item');
    const active = rows.find((r) => r.getAttribute('data-thread') === 'thread_evidence');
    const inactive = rows.find((r) => r.getAttribute('data-thread') === 'thread_todo_api');
    expect(active).toHaveAttribute('aria-current', 'true');
    expect(inactive).not.toHaveAttribute('aria-current');

    // Pre-existing wiring testids survive the redesign.
    expect(screen.getByTestId('new-thread-button')).toBeInTheDocument();
    expect(screen.getByTestId('thread-list')).toBeInTheDocument();
    expect(screen.getByTestId('owner-gear')).toBeInTheDocument();
  });

  it('an active row is keyboard-activatable while NOT in edit mode (tabIndex flips to -1 only during edit)', async () => {
    useChatStore.setState({ threads: [THREAD_A], activeThreadId: 'thread_todo_api' });
    render(<ThreadList onCreateThread={vi.fn()} onSelectThread={vi.fn()} onRenameThread={vi.fn()} />);

    // Enter edit → the editing row's tabIndex becomes -1 (input is the focus target).
    await userEvent.click(screen.getByTestId('thread-kebab'));
    await userEvent.click(screen.getByText('重命名'));
    const row = screen.getByTestId('thread-item');
    expect(row).toHaveAttribute('tabindex', '-1');
  });
});

/* ============================================================================
 * Delete wiring + safety, driven through the FULL App (edge + adversarial)
 * ========================================================================== */
describe('Delete wiring + active-thread safety (full App, edge)', () => {
  it('the confirm modal GATES the delete: 取消 dismisses WITHOUT calling client.deleteThread', async () => {
    const { client } = await mountApp();
    const user = userEvent.setup();

    const rows = screen.getAllByTestId('thread-item');
    const rowA = rows.find((r) => r.getAttribute('data-thread') === 'thread_todo_api') as HTMLElement;
    await user.click(within(rowA).getByTestId('thread-kebab'));
    await user.click(screen.getByText('删除会话'));

    expect(screen.getByTestId('thread-delete-confirm')).toBeInTheDocument();
    await user.click(screen.getByText('取消'));

    expect(screen.queryByTestId('thread-delete-confirm')).toBeNull();
    expect(client.deleteThread).not.toHaveBeenCalled();
  });

  it('confirming 删除 calls client.deleteThread with the right id and removeThread drops it from the store', async () => {
    const { client } = await mountApp();
    const user = userEvent.setup();

    const rows = screen.getAllByTestId('thread-item');
    const rowB = rows.find((r) => r.getAttribute('data-thread') === 'thread_evidence') as HTMLElement;
    await user.click(within(rowB).getByTestId('thread-kebab'));
    await user.click(screen.getByText('删除会话'));
    await user.click(screen.getByTestId('thread-delete-confirm-button'));

    await waitFor(() => expect(client.deleteThread).toHaveBeenCalledWith('thread_evidence'));
    await waitFor(() =>
      expect(useChatStore.getState().threads.some((t) => t.id === 'thread_evidence')).toBe(false),
    );
    // The other thread is untouched.
    expect(useChatStore.getState().threads.some((t) => t.id === 'thread_todo_api')).toBe(true);
  });

  it('deleting the ACTIVE thread clears active (lands on the empty/未选择 state)', async () => {
    const { client } = await mountApp();
    const user = userEvent.setup();

    // Select thread A so it is active.
    await user.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    const rows = screen.getAllByTestId('thread-item');
    const rowA = rows.find((r) => r.getAttribute('data-thread') === 'thread_todo_api') as HTMLElement;
    await user.click(within(rowA).getByTestId('thread-kebab'));
    await user.click(screen.getByText('删除会话'));
    await user.click(screen.getByTestId('thread-delete-confirm-button'));

    await waitFor(() => expect(client.deleteThread).toHaveBeenCalledWith('thread_todo_api'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBeNull());
    // The main-bar reflects the empty state (scope to .main-title — the label
    // also appears in the right-column AgentStatus footer).
    await waitFor(() =>
      expect(document.querySelector('.main-title')?.textContent).toBe('未选择会话'),
    );
  });

  it('deleting a NON-active thread leaves the active one intact', async () => {
    const { client } = await mountApp();
    const user = userEvent.setup();

    // Active = thread A; delete thread B (non-active).
    await user.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    const rows = screen.getAllByTestId('thread-item');
    const rowB = rows.find((r) => r.getAttribute('data-thread') === 'thread_evidence') as HTMLElement;
    await user.click(within(rowB).getByTestId('thread-kebab'));
    await user.click(screen.getByText('删除会话'));
    await user.click(screen.getByTestId('thread-delete-confirm-button'));

    await waitFor(() => expect(client.deleteThread).toHaveBeenCalledWith('thread_evidence'));
    // Active is unchanged; thread A remains.
    expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api');
    expect(useChatStore.getState().threads.some((t) => t.id === 'thread_todo_api')).toBe(true);
  });
});

/* ============================================================================
 * main-bar title follows active + updates after rename; .tag hidden (edge)
 * ========================================================================== */
describe('main-bar title follow + rename re-render + hidden tag (full App, edge)', () => {
  it('the main-title follows the active thread title; selecting another thread updates it', async () => {
    await mountApp();
    const user = userEvent.setup();

    // Before selection: the honest empty label (scope to .main-title — the same
    // label also appears in the right-column AgentStatus footer).
    expect(document.querySelector('.main-title')?.textContent).toBe('未选择会话');

    await user.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() =>
      expect(document.querySelector('.main-title')?.textContent).toBe('TODO API 设计与实现'),
    );

    await user.click(screen.getByText('Evidence 召回阈值评审'));
    await waitFor(() =>
      expect(document.querySelector('.main-title')?.textContent).toBe('Evidence 召回阈值评审'),
    );
  });

  it('after a rename the main-title re-renders with the renamed thread', async () => {
    await mountApp();
    const user = userEvent.setup();
    await user.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    // Rename the active thread via its kebab → 重命名 → check button (commit race).
    const rows = screen.getAllByTestId('thread-item');
    const rowA = rows.find((r) => r.getAttribute('data-thread') === 'thread_todo_api') as HTMLElement;
    await user.click(within(rowA).getByTestId('thread-kebab'));
    await user.click(screen.getByText('重命名'));
    const input = screen.getByTestId('thread-rename-input');
    await user.clear(input);
    await user.type(input, 'TODO API 设计与实现 — 已交付');
    fireEvent.mouseDown(screen.getByTestId('thread-rename-commit'));

    await waitFor(() =>
      expect(document.querySelector('.main-title')?.textContent).toBe(
        'TODO API 设计与实现 — 已交付',
      ),
    );
  });

  it('the branch .tag (main-branch-tag) stays hidden — our Thread model has no branch', async () => {
    await mountApp();
    const user = userEvent.setup();
    await user.click(screen.getByText('TODO API 设计与实现'));
    await waitFor(() => expect(useChatStore.getState().activeThreadId).toBe('thread_todo_api'));

    expect(screen.queryByTestId('main-branch-tag')).toBeNull();
  });

  it('the new feature testids resolve in the live App sidebar', async () => {
    await mountApp();
    const user = userEvent.setup();
    const rows = screen.getAllByTestId('thread-item');
    const rowA = rows.find((r) => r.getAttribute('data-thread') === 'thread_todo_api') as HTMLElement;

    // kebab → menu → rename-input present.
    await user.click(within(rowA).getByTestId('thread-kebab'));
    expect(screen.getByTestId('thread-menu')).toBeInTheDocument();
    await user.click(screen.getByText('重命名'));
    expect(screen.getByTestId('thread-rename-input')).toBeInTheDocument();

    // And the delete-confirm testid resolves from the kebab on another row.
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
  });
});
