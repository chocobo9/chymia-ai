// @vitest-environment jsdom
//
// 账户与密钥 (AccountsPane) — web gate for the BYOK provider-account pane that the
// dev wired into SettingsOverlay (was a 未接入 stub). Authored by the INDEPENDENT
// QA instance (dev≠QA): the dev shipped happy-path; this file is the edge +
// adversarial gate.
//
// Renders <SettingsOverlay> directly (settings-catalog.edge.test.tsx pattern),
// navigates to the 账户与密钥 pane via its nav testid, and drives a REAL ApiClient
// whose fetch is stubbed to reject — the four account methods are spied so we
// assert the exact calls + the masked render contract (the key is write-only; the
// list shows only a badge, never a raw key).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountSummary } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

/** A configured OpenAI account WITH a key (masked: hasApiKey only, no raw key). */
const OPENAI_WITH_KEY: AccountSummary = {
  id: 'my-openai',
  clientId: 'openai',
  authType: 'api_key',
  displayName: 'my-openai-work',
  baseUrl: 'https://proxy.example/v1',
  createdAt: 1000,
  updatedAt: 1000,
  hasApiKey: true,
};

/** An Anthropic account WITHOUT a key (falls back to the CLI's ambient login). */
const ANTHROPIC_NO_KEY: AccountSummary = {
  id: 'claude-sub',
  clientId: 'anthropic',
  authType: 'oauth',
  displayName: 'claude-subscription',
  createdAt: 2000,
  updatedAt: 2000,
  hasApiKey: false,
};

function makeClient(): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  // The roster catalog the members pane needs (mount lands on 成员管理).
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  // Account methods spied per-test (defaults below; overridden where needed).
  vi.spyOn(client, 'listAccounts').mockResolvedValue([]);
  vi.spyOn(client, 'createAccount').mockResolvedValue(OPENAI_WITH_KEY);
  vi.spyOn(client, 'updateAccount').mockResolvedValue(OPENAI_WITH_KEY);
  vi.spyOn(client, 'deleteAccount').mockResolvedValue(undefined);
  return client;
}

/** Render the overlay and click into the 账户与密钥 pane. */
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
  // The pane mounts and fires its initial list load.
  await waitFor(() => expect(client.listAccounts).toHaveBeenCalled());
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AccountsPane — empty + list render (happy + edge)', () => {
  it('[happy] an empty account list shows the honest empty-state note', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([]);
    await openAccountsPane(client);
    expect(await screen.findByTestId('accounts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('account-row')).not.toBeInTheDocument();
  });

  it('[edge] a configured account renders a row with the ✓ badge (data-haskey=true)', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');
    expect(row).toHaveAttribute('data-account', 'my-openai');
    expect(row).toHaveAttribute('data-client', 'openai');
    expect(within(row).getByTestId('account-haskey')).toHaveAttribute('data-haskey', 'true');
    // The base-url override is shown for an api_key account.
    expect(within(row).getByTestId('account-baseurl')).toHaveTextContent('https://proxy.example/v1');
  });

  it('[edge] a key-less account renders data-haskey=false (无密钥)', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([ANTHROPIC_NO_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');
    expect(within(row).getByTestId('account-haskey')).toHaveAttribute('data-haskey', 'false');
  });

  it('[adversarial] the rendered DOM shows only the badge — no raw key string is ever in the tree', async () => {
    const client = makeClient();
    // The masked summary carries no key field at all; the UI must surface only
    // the ✓ badge, never anything that looks like the secret. We additionally
    // assert no `sk-`/`AIza`-style token leaked into the DOM text.
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');
    expect(within(row).getByTestId('account-haskey')).toHaveTextContent('已配置密钥');
    expect(row.textContent ?? '').not.toMatch(/sk-[A-Za-z0-9]/);
    expect(row.textContent ?? '').not.toMatch(/AIza[A-Za-z0-9]/);
  });
});

describe('AccountsPane — create (happy + edge + adversarial)', () => {
  it('[happy] filling name + key, picking a provider, then 创建 POSTs the right body and reloads', async () => {
    const client = makeClient();
    // First load empty; after create the new account appears.
    vi.mocked(client.listAccounts).mockResolvedValueOnce([]).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);

    await userEvent.selectOptions(screen.getByTestId('account-clientid'), 'openai');
    await userEvent.type(screen.getByTestId('account-displayname'), 'my-openai-work');
    await userEvent.type(screen.getByTestId('account-apikey'), 'sk-live-openai-aaa111');
    await userEvent.click(screen.getByTestId('account-create-submit'));

    await waitFor(() => expect(client.createAccount).toHaveBeenCalledTimes(1));
    expect(client.createAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'openai',
        displayName: 'my-openai-work',
        apiKey: 'sk-live-openai-aaa111',
      }),
    );
    // The list reloaded after the create (mount load + post-create reload).
    expect(vi.mocked(client.listAccounts).mock.calls.length).toBeGreaterThanOrEqual(2);
    // The new row is now on screen.
    expect(await screen.findByTestId('account-row')).toHaveAttribute('data-account', 'my-openai');
  });

  it('[edge] 创建 is disabled until the displayName is non-empty', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([]);
    await openAccountsPane(client);
    const submit = screen.getByTestId('account-create-submit');
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByTestId('account-displayname'), 'work');
    expect(submit).toBeEnabled();
  });

  it('[adversarial] a whitespace-only displayName keeps 创建 disabled (no blank account)', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([]);
    await openAccountsPane(client);
    await userEvent.type(screen.getByTestId('account-displayname'), '   ');
    expect(screen.getByTestId('account-create-submit')).toBeDisabled();
    expect(client.createAccount).not.toHaveBeenCalled();
  });

  it('[adversarial] createAccount rejecting shows the inline error and does not crash the pane', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([]);
    vi.mocked(client.createAccount).mockRejectedValue(new Error('凭据写入失败'));
    await openAccountsPane(client);

    await userEvent.type(screen.getByTestId('account-displayname'), 'broken');
    await userEvent.type(screen.getByTestId('account-apikey'), 'sk-will-fail-000');
    await userEvent.click(screen.getByTestId('account-create-submit'));

    const err = await screen.findByText('凭据写入失败');
    expect(err).toHaveClass('member-edit-error');
    // The pane is still mounted and interactive (the create form is still there).
    expect(screen.getByTestId('account-create-form')).toBeInTheDocument();
  });
});

describe('AccountsPane — save key on a row (edge)', () => {
  it('[edge] typing a key and clicking 保存密钥 PATCHes { apiKey } for that row', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');

    await userEvent.type(within(row).getByTestId('account-key-input'), 'sk-rotated-openai-bbb222');
    await userEvent.click(within(row).getByTestId('account-key-save'));

    await waitFor(() => expect(client.updateAccount).toHaveBeenCalledTimes(1));
    expect(client.updateAccount).toHaveBeenCalledWith('my-openai', { apiKey: 'sk-rotated-openai-bbb222' });
  });

  it('[edge] 保存密钥 is disabled until the row key input is non-empty', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');
    const save = within(row).getByTestId('account-key-save');
    expect(save).toBeDisabled();
    await userEvent.type(within(row).getByTestId('account-key-input'), 'sk-new-ccc333');
    expect(save).toBeEnabled();
  });
});

describe('AccountsPane — delete (adversarial: confirm gate)', () => {
  it('[adversarial] confirming the dialog calls deleteAccount for that row id', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');

    await userEvent.click(within(row).getByTestId('account-delete'));
    await waitFor(() => expect(client.deleteAccount).toHaveBeenCalledWith('my-openai'));
  });

  it('[adversarial] cancelling the confirm dialog does NOT call deleteAccount', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    const row = await screen.findByTestId('account-row');

    await userEvent.click(within(row).getByTestId('account-delete'));
    expect(client.deleteAccount).not.toHaveBeenCalled();
  });
});

describe('AccountsPane — secret-input hardening (adversarial)', () => {
  it('[adversarial] both the create apiKey field and each row key field are type="password"', async () => {
    const client = makeClient();
    vi.mocked(client.listAccounts).mockResolvedValue([OPENAI_WITH_KEY]);
    await openAccountsPane(client);
    expect(screen.getByTestId('account-apikey')).toHaveAttribute('type', 'password');
    const row = await screen.findByTestId('account-row');
    expect(within(row).getByTestId('account-key-input')).toHaveAttribute('type', 'password');
  });
});
