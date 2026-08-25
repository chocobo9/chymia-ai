// @vitest-environment jsdom
//
// WorkspaceAudit (审计 tab) + WorkspaceTasks live-progress region — the P0-6
// front-end. Renders against a fake /api backend and the real Zustand stores,
// proving the audit log renders + expands, and the task-progress region shows an
// agent's live plan. Operability: these tabs DO things, not placeholders.

import '@testing-library/jest-dom';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import { WorkspaceAudit } from '../../packages/web/src/components/overlays/WorkspaceAudit.js';
import { WorkspaceTasks } from '../../packages/web/src/components/overlays/WorkspaceTasks.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useTaskProgressStore } from '../../packages/web/src/stores/task-progress-store.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const AUDIT_EVENTS = [
  { id: 'e1', type: 'invoked', threadId: 'T', timestamp: 1_700_000_000_000, data: { agentId: 'claude-opus', prompt: '写两数之和' } },
  { id: 'e2', type: 'session_seal', threadId: 'T', timestamp: 1_700_000_001_000, data: { agentId: 'claude-opus', sessionId: 'sess-1' } },
];

function auditClient(events: unknown[]): ApiClient {
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    const p = new URL(String(input), 'http://test').pathname;
    if (p.startsWith('/api/audit/thread/')) return Promise.resolve(json({ events }));
    return Promise.resolve(json({}, 500));
  };
  return new ApiClient({ baseUrl: 'http://test', fetchFn });
}

function tasksClient(): ApiClient {
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    const p = new URL(String(input), 'http://test').pathname;
    if (p === '/api/tasks/progress') {
      return Promise.resolve(
        json({
          snapshots: [
            {
              threadId: 'TP',
              agentId: 'claude-opus',
              status: 'running',
              updatedAt: 1,
              tasks: [
                { id: 'task-0', subject: '读文件', status: 'in_progress' },
                { id: 'task-1', subject: '修 bug', status: 'pending' },
              ],
            },
          ],
        }),
      );
    }
    if (p === '/api/tasks') return Promise.resolve(json({ tasks: [] }));
    return Promise.resolve(json({}, 500));
  };
  return new ApiClient({ baseUrl: 'http://test', fetchFn });
}

beforeEach(() => {
  useChatStore.setState({ activeThreadId: null });
  useTaskProgressStore.setState({ snapshotsByThread: {} });
});
afterEach(cleanup);

describe('WorkspaceAudit — 审计 tab', () => {
  it('renders the thread audit events and expands a row to its data payload', async () => {
    useChatStore.setState({ activeThreadId: 'T' });
    render(<WorkspaceAudit client={auditClient(AUDIT_EVENTS)} />);

    expect(await screen.findByTestId('wsp-audit')).toBeInTheDocument();
    const rows = screen.getAllByTestId('audit-event');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('audit-type')[0]).toHaveTextContent('调用');

    // Expand the first (invoked) row → its data JSON (carrying the prompt) appears.
    await userEvent.click(rows[0]!.querySelector('button')!);
    expect(await screen.findByTestId('audit-data')).toHaveTextContent('写两数之和');
  });

  it('shows an honest empty state when the thread has no events', async () => {
    useChatStore.setState({ activeThreadId: 'T2' });
    render(<WorkspaceAudit client={auditClient([])} />);
    expect(await screen.findByTestId('audit-empty')).toBeInTheDocument();
  });

  it('prompts to pick a thread when none is active', () => {
    render(<WorkspaceAudit client={auditClient([])} />);
    expect(screen.getByTestId('audit-no-thread')).toBeInTheDocument();
  });
});

describe('WorkspaceTasks — live task-progress region', () => {
  it('renders an agent\'s live TodoWrite plan loaded from GET /api/tasks/progress', async () => {
    useChatStore.setState({ activeThreadId: 'TP' });
    render(<WorkspaceTasks client={tasksClient()} />);

    const region = await screen.findByTestId('tsk-progress');
    expect(region).toHaveTextContent('进行中'); // running status pill
    const items = screen.getAllByTestId('tprog-item');
    expect(items).toHaveLength(2);
    expect(region).toHaveTextContent('读文件');
    expect(region).toHaveTextContent('修 bug');
  });
});
