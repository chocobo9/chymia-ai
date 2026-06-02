// @vitest-environment jsdom
//
// Coverage for the WorkspacePanel global-search fix (2026-06-01): the top
// "搜索全部…" input was DISABLED (即将上线). It is now enabled and routes to the
// one real search backend — evidence — by jumping to the 记忆 tab and running
// the evidence search with the typed query. Whitespace-only queries are inert.

import '@testing-library/jest-dom';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EvidenceItem } from '@clowder/shared';
import { WorkspacePanel } from '../../packages/web/src/components/overlays/WorkspacePanel.js';
import type { ApiClient } from '../../packages/web/src/lib/api.js';

function evidenceItem(): EvidenceItem {
  return {
    anchor: 'decision:2026-05-30-api-framework',
    kind: 'decision',
    status: 'active',
    title: '采用 Fastify 作为 API 框架',
    summary: '相比 Express 更快，插件生态契合本项目的 schema 校验需求。',
    updatedAt: '2026-05-30T08:15:00.000Z',
  };
}

/** A fake ApiClient exposing only the method the panel exercises. */
function fakeClient(search: ReturnType<typeof vi.fn>): ApiClient {
  return { searchEvidence: search } as unknown as ApiClient;
}

afterEach(cleanup);

describe('WorkspacePanel global search (top 搜索全部)', () => {
  it('the global search input is enabled (no longer a deferred placeholder)', () => {
    render(<WorkspacePanel onClose={vi.fn()} client={fakeClient(vi.fn())} />);
    expect(screen.getByTestId('wsp-search-input')).toBeEnabled();
  });

  it('submitting a query jumps to 记忆 and runs the evidence search, rendering the real result', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ items: [evidenceItem()], meta: { effectiveMode: 'hybrid', degraded: false } });
    render(<WorkspacePanel onClose={vi.fn()} client={fakeClient(search)} startTab="dev" />);

    await userEvent.type(screen.getByTestId('wsp-search-input'), 'API 框架决策{Enter}');

    // Routed to 记忆 …
    expect(screen.getByTestId('wsp-tab-mem')).toHaveAttribute('aria-selected', 'true');
    // … ran the REAL evidence search with the typed query …
    expect(search).toHaveBeenCalledWith('API 框架决策', { mode: 'hybrid', limit: 10 });
    // … and rendered the real result (not a fabricated row).
    const item = await screen.findByTestId('mem-item');
    expect(item).toHaveTextContent('采用 Fastify 作为 API 框架');
  });

  it('[edge] global search works when the panel already starts on the 记忆 tab', async () => {
    const search = vi
      .fn()
      .mockResolvedValue({ items: [evidenceItem()], meta: { effectiveMode: 'hybrid', degraded: false } });
    render(<WorkspacePanel onClose={vi.fn()} client={fakeClient(search)} startTab="mem" />);

    await userEvent.type(screen.getByTestId('wsp-search-input'), 'fastify{Enter}');
    expect(await screen.findByTestId('mem-item')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith('fastify', { mode: 'hybrid', limit: 10 });
  });

  it('[adversarial] a whitespace-only global query neither searches nor leaves the current tab', async () => {
    const search = vi.fn();
    render(<WorkspacePanel onClose={vi.fn()} client={fakeClient(search)} startTab="dev" />);

    await userEvent.type(screen.getByTestId('wsp-search-input'), '    {Enter}');

    expect(search).not.toHaveBeenCalled();
    expect(screen.getByTestId('wsp-tab-dev')).toHaveAttribute('aria-selected', 'true');
    // still on the 开发 placeholder, not switched to 记忆.
    expect(screen.getByTestId('wsp-soon')).toBeInTheDocument();
  });

  it('[edge] opening the 记忆 tab WITHOUT a global query stays idle (no phantom auto-search)', () => {
    const search = vi.fn();
    render(<WorkspacePanel onClose={vi.fn()} client={fakeClient(search)} startTab="mem" />);
    expect(screen.getByTestId('mem-idle')).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });
});
