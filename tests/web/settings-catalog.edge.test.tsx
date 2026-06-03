// @vitest-environment jsdom
//
// Settings — the Skill / 规则与SOP / MCP panes now render REAL read-only catalogs
// (GET /api/skills, /api/sop, /api/mcp/tools). The other unbacked panes (账户/市场/
// 通知) stay honest 未接入 placeholders. Gates the wiring + the honest split.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SkillDefinition, SopDefinition } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient, type McpToolEntry } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

const SKILLS: readonly SkillDefinition[] = [
  { id: 'tdd', description: '测试驱动开发：先写测试再实现。', triggers: ['写新功能', '修 bug'], notFor: ['纯文档'], output: '通过的测试 + 实现', sopStep: 'impl', group: 'dev-chain' },
  { id: 'expert-panel', description: '多专家分角色评审。', triggers: ['方案对比'], notFor: [], output: '评审结论', sopStep: null, group: 'multi-agent' },
];
const SOP: SopDefinition = {
  id: 'dev', domain: 'software', label: '研发 SOP',
  stages: [
    { id: 'kickoff', label: '立项', suggestedSkill: 'planner', hardRules: [{ rule: 'r1' }], pitfalls: [] },
    { id: 'impl', label: '实现', hardRules: [], pitfalls: [{ rule: 'p1' }] },
  ] as unknown as SopDefinition['stages'],
};
const MCP_TOOLS: readonly McpToolEntry[] = [
  { name: 'post_message', description: '向 thread 发一条消息（A2A / 回复）。' },
  { name: 'list_session_chain', description: '列出本 thread 的 session 链。' },
];

function fakeClient(): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no net')) });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'syncSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'getSop').mockResolvedValue(SOP);
  vi.spyOn(client, 'listMcpTools').mockResolvedValue(MCP_TOOLS);
  return client;
}

function renderSettings(): ApiClient {
  const client = fakeClient();
  render(
    <SettingsOverlay
      onClose={vi.fn()}
      client={client}
      health={{ state: 'ok' } as HealthInfo}
      socketConnected
    />,
  );
  return client;
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('settings catalogs — Skill / SOP / MCP (read-only real data)', () => {
  it('[happy] Skill 管理 lists the manifest skills (id + description + triggers + group)', async () => {
    const client = renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-skill'));
    await waitFor(() => expect(client.listSkills).toHaveBeenCalled());
    const rows = await screen.findAllByTestId('skill-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-group', 'dev-chain');
    expect(screen.getByText('测试驱动开发：先写测试再实现。')).toBeInTheDocument();
    expect(screen.getByText('写新功能')).toBeInTheDocument(); // a trigger chip
  });

  it('[edge] Skill 管理 has a 分类 filter (by group) that narrows the list', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-skill'));
    await screen.findAllByTestId('skill-row');
    // Category chips built from the real groups + 全部.
    expect(screen.getByTestId('skill-cat-全部')).toHaveTextContent('全部 (2)');
    expect(screen.getByTestId('skill-cat-dev-chain')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('skill-cat-multi-agent'));
    const rows = screen.getAllByTestId('skill-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('data-skill', 'expert-panel');
  });

  it('[edge] the 同步 button re-reads the manifest via syncSkills', async () => {
    const client = renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-skill'));
    await screen.findAllByTestId('skill-row');
    await userEvent.click(screen.getByTestId('skill-sync'));
    expect(client.syncSkills).toHaveBeenCalledTimes(1);
  });

  it('[happy] MCP 管理 lists the real tool catalog (name + description)', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-mcp'));
    const tools = await screen.findAllByTestId('mcp-tool');
    expect(tools).toHaveLength(2);
    expect(screen.getByText('post_message')).toBeInTheDocument();
    expect(screen.getByText('list_session_chain')).toBeInTheDocument();
  });

  it('[edge] 规则与 SOP shows the definition label + each stage with its rule/pitfall counts', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    const stages = await screen.findAllByTestId('sop-stage');
    expect(stages).toHaveLength(2);
    expect(screen.getByText('研发 SOP')).toBeInTheDocument();
    expect(screen.getByText('1 条硬规则')).toBeInTheDocument(); // kickoff has 1 hard rule
    expect(screen.getByText('建议 skill：planner')).toBeInTheDocument();
  });

  it('[edge] each pane fetches its OWN catalog only when opened (not all up front)', async () => {
    const client = renderSettings();
    // Mount lands on 成员管理; no catalog fetched yet.
    expect(client.listSkills).not.toHaveBeenCalled();
    expect(client.getSop).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    await waitFor(() => expect(client.getSop).toHaveBeenCalledTimes(1));
    expect(client.listMcpTools).not.toHaveBeenCalled(); // mcp not opened
  });

  it('[adversarial] the still-unbacked panes (市场/通知) stay honest 未接入 placeholders', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-market'));
    expect(await screen.findByTestId('settings-soon')).toHaveTextContent('未接入');
    await userEvent.click(screen.getByTestId('settings-nav-notif'));
    expect(await screen.findByTestId('settings-soon')).toHaveTextContent('未接入');
  });
});
