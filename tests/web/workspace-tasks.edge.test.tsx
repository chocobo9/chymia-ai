// @vitest-environment jsdom
//
// WorkspaceTasks — the operable 任务线 board (the 任务 tab). Renders the component
// against a STATEFUL fake /api/tasks backend (in-memory) + the real chat/task
// Zustand stores, and exercises the real user flow: load → create → cycle status
// → delete. This is the "operable, not just observable" proof — the tab DOES
// things, it isn't a placeholder.

import '@testing-library/jest-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskItem } from '@choco/shared';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import { WorkspaceTasks } from '../../packages/web/src/components/overlays/WorkspaceTasks.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useTaskStore } from '../../packages/web/src/stores/task-store.js';

const THREAD = 'thread_board_1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A stateful in-memory /api/tasks backend so the board's CRUD round-trips. */
function makeFakeApi(): ApiClient {
  const tasks: TaskItem[] = [];
  let seq = 0;
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input), 'http://test');
    const method = init?.method ?? 'GET';
    const idMatch = u.pathname.match(/^\/api\/tasks\/(.+)$/);

    if (u.pathname === '/api/tasks' && method === 'GET') {
      const threadId = u.searchParams.get('threadId');
      return Promise.resolve(jsonResponse({ tasks: tasks.filter((t) => t.threadId === threadId) }));
    }
    if (u.pathname === '/api/tasks' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { threadId: string; title: string; why?: string };
      const now = 1_700_000_000_000 + seq;
      const task: TaskItem = {
        id: `task_${seq++}`,
        threadId: body.threadId,
        title: body.title,
        why: body.why ?? '',
        status: 'todo',
        ownerCatId: null,
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
      };
      tasks.push(task);
      return Promise.resolve(jsonResponse(task, 201));
    }
    if (idMatch !== null && method === 'PATCH') {
      const id = idMatch[1];
      const patch = JSON.parse(String(init?.body)) as Partial<TaskItem>;
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx === -1) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      tasks[idx] = { ...tasks[idx]!, ...patch, updatedAt: tasks[idx]!.updatedAt + 1 };
      return Promise.resolve(jsonResponse(tasks[idx]));
    }
    if (idMatch !== null && method === 'DELETE') {
      const id = idMatch[1];
      const idx = tasks.findIndex((t) => t.id === id);
      if (idx !== -1) tasks.splice(idx, 1);
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(jsonResponse({ error: 'unhandled' }, 500));
  };
  return new ApiClient({ baseUrl: 'http://test', fetchFn });
}

function mount(client: ApiClient, threadId: string | null = THREAD): void {
  useChatStore.setState({ activeThreadId: threadId });
  render(<WorkspaceTasks client={client} />);
}

afterEach(() => {
  cleanup();
  useTaskStore.setState({ tasksByThread: {} });
  useChatStore.setState({ activeThreadId: null });
});

describe('WorkspaceTasks — operable task board', () => {
  it('[no thread] prompts to open a conversation (tasks hang on a thread)', () => {
    mount(makeFakeApi(), null);
    expect(screen.getByTestId('wsp-tasks')).toBeInTheDocument();
    expect(screen.getByTestId('tsk-empty')).toHaveTextContent('先开一个对话');
  });

  it('[empty] an empty thread shows the create-first state, not a placeholder', async () => {
    mount(makeFakeApi());
    expect(await screen.findByText('把长期事项挂在线上，不埋回聊天里')).toBeInTheDocument();
  });

  it('[create] the composer creates a task that appears as a todo card', async () => {
    mount(makeFakeApi());
    await userEvent.click(await screen.findByTestId('tsk-new'));
    await userEvent.type(screen.getByTestId('tsk-composer-title'), '把调度 tab 对齐到 Clowder');
    await userEvent.click(screen.getByTestId('tsk-composer-submit'));

    const card = await screen.findByTestId('tsk-card');
    expect(card).toHaveTextContent('把调度 tab 对齐到 Clowder');
    expect(screen.getByTestId('tsk-sec-todo')).toBeInTheDocument();
  });

  it('[cycle] tapping the status pill advances todo→doing (PATCH round-trips)', async () => {
    const client = makeFakeApi();
    mount(client);
    await userEvent.click(await screen.findByTestId('tsk-new'));
    await userEvent.type(screen.getByTestId('tsk-composer-title'), '修 gemini 跨对话串台');
    await userEvent.click(screen.getByTestId('tsk-composer-submit'));
    await screen.findByTestId('tsk-card');

    // todo pill reads 待办; click it → moves to 进行中 (doing).
    const pill = screen.getByTestId('tsk-pill');
    expect(pill).toHaveTextContent('待办');
    await userEvent.click(pill);

    await waitFor(() => expect(screen.getByTestId('tsk-sec-doing')).toBeInTheDocument());
    expect(screen.getByTestId('tsk-pill')).toHaveTextContent('进行中');
    expect(screen.queryByTestId('tsk-sec-todo')).not.toBeInTheDocument();
  });

  it('[delete] expanding a card and deleting removes it from the board', async () => {
    mount(makeFakeApi());
    await userEvent.click(await screen.findByTestId('tsk-new'));
    await userEvent.type(screen.getByTestId('tsk-composer-title'), '临时事项');
    await userEvent.click(screen.getByTestId('tsk-composer-submit'));
    await screen.findByTestId('tsk-card');

    await userEvent.click(screen.getByTestId('tsk-title')); // expand
    await userEvent.click(screen.getByTestId('tsk-del'));

    await waitFor(() => expect(screen.queryByTestId('tsk-card')).not.toBeInTheDocument());
  });
});
