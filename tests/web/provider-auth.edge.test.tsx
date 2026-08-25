// @vitest-environment jsdom
//
// 订阅 / OAuth 登录 (ProviderAuthSection) — the web gate for the OAuth/login half of
// 账户与密钥 that the dev wired ABOVE the API-key form in SettingsOverlay. Authored by
// the INDEPENDENT QA instance (dev≠QA): the dev shipped happy-path; this file is the
// edge + adversarial gate.
//
// Renders <SettingsOverlay> directly (accounts-pane.edge.test.tsx pattern), navigates
// to the 账户与密钥 pane, and drives a REAL ApiClient whose fetch is stubbed to reject —
// the auth methods (getAuthStatus/providerLogin/providerLogout) + listAccounts are
// spied so we assert the exact calls, the per-provider button gating, the
// click→action→reload contract, and the inline-error path WITHOUT a real CLI/browser.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProviderAuthStatus } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

/** claude: logged in via subscription, with a real email · plan detail. */
const ANTHROPIC_LOGGED_IN: ProviderAuthStatus = {
  clientId: 'anthropic',
  cli: 'claude',
  available: true,
  loggedIn: true,
  supportsLogin: true,
  detail: 'me@anthropic.test · max',
};

/** codex: installed but not logged in (login affordance must show). */
const OPENAI_LOGGED_OUT: ProviderAuthStatus = {
  clientId: 'openai',
  cli: 'codex',
  available: true,
  loggedIn: false,
  supportsLogin: true,
};

/** google/agy: available, but no scriptable login (implicit OAuth) → no button, a note. */
const GOOGLE_IMPLICIT: ProviderAuthStatus = {
  clientId: 'google',
  cli: 'agy',
  available: true,
  loggedIn: null,
  supportsLogin: false,
  detail: 'Gemini 现由 Antigravity `agy` 后端驱动，使用 Google OAuth，但无 CLI 登录子命令。',
};

/** anthropic CLI not installed on this machine → "未安装", no button. */
const ANTHROPIC_UNAVAILABLE: ProviderAuthStatus = {
  clientId: 'anthropic',
  cli: 'claude',
  available: false,
  loggedIn: null,
  supportsLogin: true,
};

/** A realistic 3-provider snapshot: claude logged in, codex logged out, google/agy implicit. */
const MIXED: readonly ProviderAuthStatus[] = [ANTHROPIC_LOGGED_IN, OPENAI_LOGGED_OUT, GOOGLE_IMPLICIT];

function makeClient(): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  // Mount lands on 成员管理; the roster catalog the members pane needs.
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  // The accounts pane also loads the BYOK account list — silence it with [].
  vi.spyOn(client, 'listAccounts').mockResolvedValue([]);
  // Auth methods spied per-test (defaults here; overridden where needed).
  vi.spyOn(client, 'getAuthStatus').mockResolvedValue(MIXED);
  vi.spyOn(client, 'providerLogin').mockResolvedValue(undefined);
  vi.spyOn(client, 'providerLogout').mockResolvedValue(undefined);
  return client;
}

/** Render the overlay and click into the 账户与密钥 pane (which holds the auth section). */
async function openAccountsPane(client: ApiClient): Promise<void> {
  render(
    <SettingsOverlay
      onClose={vi.fn()}
      client={client}
      health={{ state: 'ok' } as HealthInfo}
      socketConnected
    />,
  );
  await userEvent.click(screen.getByTestId('settings-nav-accounts'));
  // The auth section fires its initial status load on mount.
  await waitFor(() => expect(client.getAuthStatus).toHaveBeenCalled());
}

/** Find the auth row for a given provider clientId. */
async function authRow(clientId: string): Promise<HTMLElement> {
  await screen.findByTestId('provider-auth');
  const rows = await screen.findAllByTestId('provider-auth-row');
  const row = rows.find((r) => r.getAttribute('data-client') === clientId);
  if (row === undefined) throw new Error(`no provider-auth-row for ${clientId}`);
  return row;
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ProviderAuthSection — per-provider render gating (happy + edge)', () => {
  it('[happy] renders one row per provider returned by getAuthStatus', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const rows = await screen.findAllByTestId('provider-auth-row');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute('data-client'))).toEqual(['anthropic', 'openai', 'google']);
  });

  it('[edge] a logged-in provider shows its detail + a 登出 button and NO 登录 button', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const row = await authRow('anthropic');
    expect(row).toHaveAttribute('data-loggedin', 'true');
    expect(row.textContent ?? '').toContain('me@anthropic.test · max');
    expect(within(row).getByTestId('provider-logout')).toBeInTheDocument();
    expect(within(row).queryByTestId('provider-login')).not.toBeInTheDocument();
  });

  it('[edge] a not-logged-in provider shows a 登录 button and NO 登出 button', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const row = await authRow('openai');
    expect(row).toHaveAttribute('data-loggedin', 'false');
    expect(within(row).getByTestId('provider-login')).toBeInTheDocument();
    expect(within(row).queryByTestId('provider-logout')).not.toBeInTheDocument();
  });

  it('[edge] gemini (supportsLogin:false, loggedIn:null) shows NO login/logout button — just the note', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const row = await authRow('google');
    expect(row).toHaveAttribute('data-loggedin', 'null');
    expect(within(row).queryByTestId('provider-login')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('provider-logout')).not.toBeInTheDocument();
    expect(row.textContent ?? '').toContain('OAuth');
  });

  it('[adversarial] an unavailable CLI shows "未安装" and NO button (cannot login to a missing CLI)', async () => {
    const client = makeClient();
    // claude not installed; gemini fine. (codex omitted to keep the snapshot tight.)
    vi.mocked(client.getAuthStatus).mockResolvedValue([ANTHROPIC_UNAVAILABLE, GOOGLE_IMPLICIT]);
    await openAccountsPane(client);
    const row = await authRow('anthropic');
    expect(row.textContent ?? '').toContain('未安装 claude');
    expect(within(row).queryByTestId('provider-login')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('provider-logout')).not.toBeInTheDocument();
  });
});

describe('ProviderAuthSection — login / logout actions reload status (happy + edge)', () => {
  it('[happy] clicking 登录 calls providerLogin with that clientId, THEN reloads via getAuthStatus', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const initialStatusCalls = vi.mocked(client.getAuthStatus).mock.calls.length;
    const row = await authRow('openai');

    await userEvent.click(within(row).getByTestId('provider-login'));

    await waitFor(() => expect(client.providerLogin).toHaveBeenCalledTimes(1));
    expect(client.providerLogin).toHaveBeenCalledWith('openai');
    // The action reloads status afterwards (extra getAuthStatus call beyond mount).
    await waitFor(() =>
      expect(vi.mocked(client.getAuthStatus).mock.calls.length).toBeGreaterThan(initialStatusCalls),
    );
    expect(client.providerLogout).not.toHaveBeenCalled();
  });

  it('[edge] clicking 登出 calls providerLogout with that clientId, THEN reloads via getAuthStatus', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const initialStatusCalls = vi.mocked(client.getAuthStatus).mock.calls.length;
    const row = await authRow('anthropic');

    await userEvent.click(within(row).getByTestId('provider-logout'));

    await waitFor(() => expect(client.providerLogout).toHaveBeenCalledTimes(1));
    expect(client.providerLogout).toHaveBeenCalledWith('anthropic');
    await waitFor(() =>
      expect(vi.mocked(client.getAuthStatus).mock.calls.length).toBeGreaterThan(initialStatusCalls),
    );
    expect(client.providerLogin).not.toHaveBeenCalled();
  });

  it('[edge] clicking 刷新状态 re-fetches getAuthStatus without any login/logout', async () => {
    const client = makeClient();
    await openAccountsPane(client);
    const before = vi.mocked(client.getAuthStatus).mock.calls.length;

    await userEvent.click(screen.getByTestId('provider-auth-refresh'));

    await waitFor(() =>
      expect(vi.mocked(client.getAuthStatus).mock.calls.length).toBeGreaterThan(before),
    );
    expect(client.providerLogin).not.toHaveBeenCalled();
    expect(client.providerLogout).not.toHaveBeenCalled();
  });
});

describe('ProviderAuthSection — failure paths (adversarial)', () => {
  it('[adversarial] providerLogin rejecting (409 reason) surfaces the reason in .member-edit-error, no crash', async () => {
    const client = makeClient();
    // Render gemini as if it momentarily exposed a login button is impossible, so we
    // make codex's login reject with a server reason. The section must catch it.
    vi.mocked(client.providerLogin).mockRejectedValue(
      new Error('gemini 用 Google 账号 OAuth，无 CLI 登录子命令'),
    );
    await openAccountsPane(client);
    const row = await authRow('openai');

    await userEvent.click(within(row).getByTestId('provider-login'));

    const err = await screen.findByText('gemini 用 Google 账号 OAuth，无 CLI 登录子命令');
    expect(err).toHaveClass('member-edit-error');
    // The section is still mounted + interactive (the refresh button is still there).
    expect(screen.getByTestId('provider-auth-refresh')).toBeInTheDocument();
    // Even on failure the section reloads status (finally → load()).
    expect(vi.mocked(client.getAuthStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('[adversarial] providerLogout rejecting surfaces the reason inline and does not unmount the section', async () => {
    const client = makeClient();
    vi.mocked(client.providerLogout).mockRejectedValue(new Error('claude 未安装'));
    await openAccountsPane(client);
    const row = await authRow('anthropic');

    await userEvent.click(within(row).getByTestId('provider-logout'));

    const err = await screen.findByText('claude 未安装');
    expect(err).toHaveClass('member-edit-error');
    expect(screen.getByTestId('provider-auth')).toBeInTheDocument();
  });

  it('[adversarial] getAuthStatus rejecting on load shows an error but the BYOK account form still renders', async () => {
    const client = makeClient();
    vi.mocked(client.getAuthStatus).mockRejectedValue(new Error('鉴权状态加载失败'));
    await openAccountsPane(client);
    // The auth section error is shown…
    expect(await screen.findByText('鉴权状态加载失败')).toHaveClass('member-edit-error');
    // …and the rest of the accounts pane (the BYOK create form) is unaffected.
    expect(screen.getByTestId('account-create-form')).toBeInTheDocument();
    // No provider rows render when the status load failed.
    expect(screen.queryByTestId('provider-auth-row')).not.toBeInTheDocument();
  });
});
