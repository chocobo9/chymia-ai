// @vitest-environment jsdom
//
// SkillPane per-skill toggle — EDGE + ADVERSARIAL (QA). The toggle is now
// OPERABLE: flipping it calls PUT /api/skills/:id/enabled (client.setSkillEnabled)
// which makes the backend inject that skill's markdown into the agent prompt. This
// file gates the WEB half of that contract — optimistic flip, the enabled tally,
// and the ADVERSARIAL revert-on-failure (a rejected persist must roll the checkbox
// back so the UI never lies about what is actually enabled server-side).
//
// QA-authored (did NOT write SettingsOverlay/SkillPane). Mounts the real overlay,
// navigates to Skill 管理, and spies listSkills / setSkillEnabled on the ApiClient.
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient, type SkillListEntry } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

// Real skill ids + routing metadata, mirroring the GET /api/skills payload (each
// row carries its on/off state). tdd starts ENABLED, incident-response OFF — so a
// single fixture exercises both render directions + both toggle directions.
const SKILLS: readonly SkillListEntry[] = [
  {
    id: 'tdd',
    description: '测试驱动开发：先写一个失败的测试，再写最小实现让它通过。',
    triggers: ['写新功能', '修 bug'],
    notFor: ['纯文档改动'],
    output: '红-绿-重构的工作流 + 通过的测试',
    sopStep: 'impl',
    group: 'dev-chain',
    enabled: true,
  },
  {
    id: 'incident-response',
    description: '线上故障响应：先止血、再定位、最后复盘。',
    triggers: ['线上故障', '事故'],
    notFor: ['日常迭代'],
    output: '止血措施 + 根因 + 复盘行动项',
    sopStep: null,
    group: 'ops',
    enabled: false,
  },
];

function fakeClient(): ApiClient {
  const client = new ApiClient({ baseUrl: 'http://test', fetchFn: () => Promise.reject(new Error('no net')) });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'syncSkills').mockResolvedValue(SKILLS);
  vi.spyOn(client, 'setSkillEnabled').mockResolvedValue(undefined);
  return client;
}

function renderSettings(): ApiClient {
  const client = fakeClient();
  render(
    <SettingsOverlay onClose={vi.fn()} client={client} health={{ state: 'ok' } as HealthInfo} socketConnected />,
  );
  return client;
}

/** Navigate to Skill 管理 and wait for the rows to render. */
async function openSkillPane(): Promise<void> {
  await userEvent.click(screen.getByTestId('settings-nav-skill'));
  await screen.findAllByTestId('skill-row');
}

/** The skill-toggle checkbox for a given skill id. */
function toggleFor(id: string): HTMLInputElement {
  const boxes = screen.getAllByTestId('skill-toggle') as HTMLInputElement[];
  const box = boxes.find((b) => b.getAttribute('data-skill') === id);
  if (box === undefined) throw new Error(`no skill-toggle for ${id}`);
  return box;
}

/** The skill-row element for a given skill id. */
function rowFor(id: string): HTMLElement {
  const row = screen.getAllByTestId('skill-row').find((r) => r.getAttribute('data-skill') === id);
  if (row === undefined) throw new Error(`no skill-row for ${id}`);
  return row;
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Skill 管理 per-skill toggle (edge + adversarial)', () => {
  it('[happy] rows render with data-enabled + checkbox checked matching the mocked enabled state', async () => {
    renderSettings();
    await openSkillPane();

    expect(rowFor('tdd')).toHaveAttribute('data-enabled', 'true');
    expect(rowFor('incident-response')).toHaveAttribute('data-enabled', 'false');
    expect(toggleFor('tdd').checked).toBe(true);
    expect(toggleFor('incident-response').checked).toBe(false);
  });

  it('[edge] the 已启用 tally counts only enabled skills', async () => {
    renderSettings();
    await openSkillPane();
    // 2 skills, 1 enabled (tdd).
    expect(screen.getByTestId('skill-enabled-count')).toHaveTextContent('2 个 skill');
    expect(screen.getByTestId('skill-enabled-count')).toHaveTextContent('1 已启用');
  });

  it('[edge] clicking an OFF skill optimistically enables it AND calls setSkillEnabled(id, true)', async () => {
    const client = renderSettings();
    await openSkillPane();

    await userEvent.click(toggleFor('incident-response'));

    expect(client.setSkillEnabled).toHaveBeenCalledWith('incident-response', true);
    // Optimistic: the row + checkbox flip immediately (before any refetch).
    await waitFor(() => expect(toggleFor('incident-response').checked).toBe(true));
    expect(rowFor('incident-response')).toHaveAttribute('data-enabled', 'true');
    // The tally reflects the new enabled count (2 enabled now).
    expect(screen.getByTestId('skill-enabled-count')).toHaveTextContent('2 已启用');
  });

  it('[edge] clicking an ON skill optimistically disables it AND calls setSkillEnabled(id, false)', async () => {
    const client = renderSettings();
    await openSkillPane();

    await userEvent.click(toggleFor('tdd'));

    expect(client.setSkillEnabled).toHaveBeenCalledWith('tdd', false);
    await waitFor(() => expect(toggleFor('tdd').checked).toBe(false));
    expect(rowFor('tdd')).toHaveAttribute('data-enabled', 'false');
    expect(screen.getByTestId('skill-enabled-count')).toHaveTextContent('0 已启用');
  });

  it('[adversarial] a setSkillEnabled REJECT reverts the checkbox + surfaces the error (UI never lies about server state)', async () => {
    const client = renderSettings();
    vi.spyOn(client, 'setSkillEnabled').mockRejectedValue(new Error('切换失败 (HTTP 500)'));
    await openSkillPane();

    // incident-response is OFF; the click optimistically turns it on…
    await userEvent.click(toggleFor('incident-response'));
    expect(client.setSkillEnabled).toHaveBeenCalledWith('incident-response', true);

    // …but the persist rejects, so it must roll BACK to OFF and show the error.
    await waitFor(() => expect(toggleFor('incident-response').checked).toBe(false));
    expect(rowFor('incident-response')).toHaveAttribute('data-enabled', 'false');
    expect(await screen.findByText(/切换失败 \(HTTP 500\)/)).toBeInTheDocument();
    // The enabled tally is back to the original 1 (no phantom enable persisted).
    expect(screen.getByTestId('skill-enabled-count')).toHaveTextContent('1 已启用');
  });

  it('[adversarial] a failed toggle of an ON skill reverts it back to ON (not stuck OFF)', async () => {
    const client = renderSettings();
    vi.spyOn(client, 'setSkillEnabled').mockRejectedValue(new Error('切换失败 (HTTP 404)'));
    await openSkillPane();

    // tdd is ON; clicking optimistically turns it off, then the reject reverts to ON.
    await userEvent.click(toggleFor('tdd'));
    expect(client.setSkillEnabled).toHaveBeenCalledWith('tdd', false);
    await waitFor(() => expect(toggleFor('tdd').checked).toBe(true));
    expect(rowFor('tdd')).toHaveAttribute('data-enabled', 'true');
  });
});
