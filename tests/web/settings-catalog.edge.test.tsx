// @vitest-environment jsdom
//
// Settings — the Skill / 规则与SOP / MCP panes now render REAL read-only catalogs
// (GET /api/skills, /api/sop, /api/mcp/tools). The other unbacked panes (账户/市场/
// 通知) stay honest 未接入 placeholders. Gates the wiring + the honest split.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SopDefinition } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient, type McpToolEntry, type SkillListEntry } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

const SKILLS: readonly SkillListEntry[] = [
  { id: 'tdd', description: '测试驱动开发：先写测试再实现。', triggers: ['写新功能', '修 bug'], notFor: ['纯文档'], output: '通过的测试 + 实现', sopStep: 'impl', group: 'dev-chain', enabled: false },
  { id: 'expert-panel', description: '多专家分角色评审。', triggers: ['方案对比'], notFor: [], output: '评审结论', sopStep: null, group: 'multi-agent', enabled: false },
];
const MANUAL = { type: 'manual_only', reason: '人工审查' } as const;
const SOP: SopDefinition = {
  id: 'dev',
  domain: 'engineering',
  label: '研发 SOP',
  description: 'hint 告示牌，非硬 gate。',
  stages: [
    {
      id: 'kickoff',
      label: '立项',
      suggestedSkill: 'planner',
      hardRules: [{ id: 'k1', text: 'spec 必须有 AC checklist', severity: 'blocker', predicate: MANUAL }],
      pitfalls: [{ id: 'kp', text: '没确认就直接动手', severity: 'warn', predicate: MANUAL }],
    },
    { id: 'impl', label: '实现', hardRules: [], pitfalls: [] },
  ] as unknown as SopDefinition['stages'],
};
const MCP_TOOLS: readonly McpToolEntry[] = [
  { name: 'post_message', description: '向 thread 发一条消息（A2A / 回复）。' },
  { name: 'list_session_chain', description: '列出本 thread 的 session 链。' },
];

const RULES = {
  sharedRules: [
    {
      path: 'cat-cafe-skills/refs/shared-rules.md',
      content: '# Shared\n\nProject guide.',
      exists: true,
      lineCount: 3,
      consumption: {
        kind: 'reference',
        label: 'reference',
        detail: 'Shared collaboration rules.',
        consumers: ['/api/rules'],
      },
    },
    {
      path: 'docs/SOP.md',
      content: '',
      exists: false,
      lineCount: 0,
      consumption: {
        kind: 'reference',
        label: 'reference',
        detail: 'Human SOP reference.',
        consumers: ['/api/rules'],
      },
    },
  ],
  providerGuides: [
    {
      provider: 'claude',
      path: 'CLAUDE.md',
      content: '# CLAUDE\n\nProject guide.',
      exists: true,
      lineCount: 3,
      consumption: {
        kind: 'harness-injected',
        label: 'harness injected',
        detail: 'Claude Code reads project CLAUDE.md into model context.',
        consumers: ['Claude Code project-doc loader'],
      },
    },
    {
      provider: 'codex',
      path: 'AGENTS.md',
      content: '',
      exists: false,
      lineCount: 0,
      consumption: {
        kind: 'harness-injected',
        label: 'harness injected',
        detail: 'Codex reads AGENTS.md when present.',
        consumers: ['Codex CLI project-doc loader'],
      },
    },
  ],
  l0Prompts: {
    template: {
      path: 'assets/system-prompts/system-prompt-l0.md',
      content: '',
      exists: false,
      lineCount: 0,
      consumption: {
        kind: 'actual-prompt',
        label: 'actual prompt',
        detail: 'Template is compiled per agent when present.',
        consumers: ['SystemPromptBuilder'],
      },
    },
    compiledByAgent: [
      {
        agentId: 'claude-opus',
        displayName: 'Claude',
        compiled: 'compiled prompt preview',
        error: null,
        consumption: {
          kind: 'actual-prompt',
          label: 'actual prompt',
          detail: 'Per-agent compiled L0.',
          consumers: ['SystemPromptBuilder'],
        },
      },
    ],
    customization: {
      templatePath: 'assets/system-prompts/system-prompt-l0.md',
      compileScript: 'SystemPromptBuilder',
      verifyCommand: 'npx tsc --noEmit',
    },
  },
  sop: SOP,
};

function fakeClient(): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no net')) });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'syncSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'getSop').mockResolvedValue(SOP);
  vi.spyOn(client, 'listMcpTools').mockResolvedValue(MCP_TOOLS);
  Object.assign(client, { getRules: vi.fn().mockResolvedValue(RULES) });
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

  it('[happy] MCP 管理 groups the real tools under the built-in server card', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-mcp'));
    const server = await screen.findByTestId('mcp-server');
    expect(server).toHaveAttribute('data-server', 'builtin');
    expect(within(server).getByText('内置 MCP 服务')).toBeInTheDocument();
    const tools = within(server).getAllByTestId('mcp-tool');
    expect(tools).toHaveLength(2);
    expect(screen.getByText('post_message')).toBeInTheDocument();
    expect(screen.getByText('list_session_chain')).toBeInTheDocument();
  });

  it('[edge] 规则与 SOP shows the consumption note + each stage rule/pitfall TEXT with severity', async () => {
    renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    const stages = await screen.findAllByTestId('sop-stage');
    expect(stages).toHaveLength(2);
    expect(screen.getByText('研发 SOP')).toBeInTheDocument();
    // The consumption note (how the SOP is used — a hint, not a gate).
    expect(screen.getByTestId('sop-consumption')).toHaveTextContent('hint 告示牌');
    // The ACTUAL rule + pitfall text (not just counts) + severity badge.
    const rule = screen.getByTestId('sop-rule');
    expect(rule).toHaveTextContent('spec 必须有 AC checklist');
    expect(within(rule).getByText('阻断')).toBeInTheDocument(); // blocker severity
    expect(screen.getByTestId('sop-pitfall')).toHaveTextContent('没确认就直接动手');
  });

  it('[red] rules pane shows Clowder-style sources, consumption chain, previews, and SOP stages', async () => {
    const client = renderSettings();
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    await waitFor(() =>
      expect((client as unknown as { getRules: ReturnType<typeof vi.fn> }).getRules).toHaveBeenCalledTimes(1),
    );

    expect(await screen.findByTestId('rules-consumption-legend')).toHaveTextContent('actual prompt');
    expect(screen.getByTestId('rules-shared')).toHaveTextContent('cat-cafe-skills/refs/shared-rules.md');
    expect(screen.getByTestId('rules-shared')).not.toHaveTextContent('CLAUDE.md');
    expect(screen.getByTestId('rules-provider-guides')).toHaveTextContent('AGENTS.md');
    expect(screen.getByTestId('rules-provider-guides')).toHaveTextContent('CLAUDE.md');
    expect(screen.getByTestId('rules-l0')).toHaveTextContent('assets/system-prompts/system-prompt-l0.md');
    expect(screen.getByTestId('rules-l0')).toHaveTextContent('npx tsc --noEmit');
    expect(screen.getByTestId('rule-preview-docs/SOP.md')).toBeDisabled();

    await userEvent.click(screen.getByTestId('rule-preview-CLAUDE.md'));
    let preview = await screen.findByRole('dialog', { name: /CLAUDE.md/ });
    expect(preview).toHaveTextContent('Project guide.');
    await userEvent.click(screen.getByLabelText('关闭预览'));

    await userEvent.click(screen.getByTestId('rule-preview-cat-cafe-skills/refs/shared-rules.md'));
    preview = await screen.findByRole('dialog', { name: /shared-rules.md/ });
    expect(preview).toHaveTextContent('Project guide.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /shared-rules.md/ })).not.toBeInTheDocument());

    await userEvent.click(screen.getByTestId('rule-preview-cat-cafe-skills/refs/shared-rules.md'));
    preview = await screen.findByRole('dialog', { name: /shared-rules.md/ });
    await userEvent.click(preview);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /shared-rules.md/ })).not.toBeInTheDocument());

    expect(await screen.findAllByTestId('sop-stage')).toHaveLength(2);
  });

  it('[edge] rules pane hides the L0 section when neither template nor compiled preview is available', async () => {
    const client = renderSettings();
    const noL0 = {
      ...RULES,
      l0Prompts: {
        ...RULES.l0Prompts,
        template: { ...RULES.l0Prompts.template, exists: false, content: '' },
        compiledByAgent: [],
      },
    };
    (client as unknown as { getRules: ReturnType<typeof vi.fn> }).getRules.mockResolvedValueOnce(noL0);
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    await screen.findByTestId('rules-consumption-legend');
    expect(screen.queryByTestId('rules-l0')).not.toBeInTheDocument();
  });

  it('[edge] each pane fetches its OWN catalog only when opened (not all up front)', async () => {
    const client = renderSettings();
    // Mount lands on 成员管理; no catalog fetched yet.
    expect(client.listSkills).not.toHaveBeenCalled();
    expect(client.getSop).not.toHaveBeenCalled();
    expect((client as unknown as { getRules: ReturnType<typeof vi.fn> }).getRules).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('settings-nav-rules'));
    await waitFor(() =>
      expect((client as unknown as { getRules: ReturnType<typeof vi.fn> }).getRules).toHaveBeenCalledTimes(1),
    );
    expect(client.getSop).not.toHaveBeenCalled();
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
