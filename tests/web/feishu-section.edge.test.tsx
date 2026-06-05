// @vitest-environment jsdom
//
// FeishuSection (飞书/Lark 自建应用 长连接) — web EDGE + ADVERSARIAL gate for the Feishu
// pane the dev wired into SettingsOverlay's IM 对接 tab (between 个人微信 and 企业微信).
// Authored by the INDEPENDENT QA instance (dev≠QA §0.5.3): the dev shipped the happy-path
// component; this file drives a REAL ApiClient (feishu* methods spied) through every UI
// branch — config-driven initial render, the connected badge, the masked-secret prefill
// discipline (write-only, omitted-when-blank), the password field, and the load/save
// failure paths. The IM pane ALSO mounts WeixinSection + WeChatPane, so weixinStatus /
// getWeChatConfig are stubbed too (else those siblings crash the tab). NO product code
// modified (tests/ only).
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WeChatSettingsView } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient, type FeishuConfigView } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

const WEBHOOK_PATH = '/api/adapters/wechat/webhook';
const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com';

/** Empty WeCom view — the IM pane's WeChatPane sibling needs getWeChatConfig to resolve. */
const EMPTY_WECHAT_VIEW: WeChatSettingsView = {
  corpId: '',
  agentId: '',
  token: '',
  apiBase: DEFAULT_API_BASE,
  enabled: false,
  hasSecret: false,
  hasEncodingAesKey: false,
  webhookPath: WEBHOOK_PATH,
  ready: false,
};

/** A realistic configured Feishu masked view (real cli_ app id; secret presence only). */
const CONFIGURED_VIEW: FeishuConfigView = {
  appId: 'cli_a1b2c3d4e5f60718',
  enabled: true,
  hasAppSecret: true,
  domain: 'feishu',
  ready: true,
};

/** A never-configured masked view (first-run state). */
const EMPTY_FEISHU_VIEW: FeishuConfigView = {
  appId: '',
  enabled: false,
  hasAppSecret: false,
  domain: 'feishu',
  ready: false,
};

interface FeishuStubs {
  readonly config?: FeishuConfigView;
  readonly connected?: boolean;
}

/**
 * A real ApiClient whose raw fetch rejects (nothing hits the wire); listAgents +
 * the sibling-pane probes (weixinStatus, getWeChatConfig) + the feishu* methods are
 * spied so we drive FeishuSection deterministically.
 */
function makeClient(feishu: FeishuStubs = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  // Mount lands on 成员管理 (roster) before we navigate to IM 对接.
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  // IM-pane siblings — keep them alive so the tab renders.
  vi.spyOn(client, 'getWeChatConfig').mockResolvedValue(EMPTY_WECHAT_VIEW);
  vi.spyOn(client, 'weixinStatus').mockResolvedValue({ connected: false, hasToken: false });
  // The FeishuSection seam under test.
  vi.spyOn(client, 'getFeishuConfig').mockResolvedValue(feishu.config ?? EMPTY_FEISHU_VIEW);
  vi.spyOn(client, 'feishuStatus').mockResolvedValue({
    connected: feishu.connected ?? false,
    ready: (feishu.config ?? EMPTY_FEISHU_VIEW).ready,
  });
  vi.spyOn(client, 'setFeishuConfig').mockResolvedValue({
    config: feishu.config ?? EMPTY_FEISHU_VIEW,
    status: { connected: feishu.connected ?? false, ready: (feishu.config ?? EMPTY_FEISHU_VIEW).ready },
  });
  return client;
}

/** Render the overlay and open the IM 对接 pane (FeishuSection sits in it). */
async function openImPane(client: ApiClient): Promise<void> {
  render(
    <SettingsOverlay
      onClose={vi.fn()}
      client={client}
      health={{ state: 'ok' } as HealthInfo}
      socketConnected
    />,
  );
  await userEvent.click(screen.getByRole('tab', { name: 'IM 对接' }));
  await screen.findByTestId('feishu-section');
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('FeishuSection — config-driven initial render (happy + edge)', () => {
  it('[happy] mounting calls getFeishuConfig + feishuStatus and prefills the appId + enabled checkbox', async () => {
    const client = makeClient({ config: CONFIGURED_VIEW, connected: true });
    await openImPane(client);

    await waitFor(() => expect(client.getFeishuConfig).toHaveBeenCalled());
    expect(client.feishuStatus).toHaveBeenCalled();
    expect(await screen.findByTestId('feishu-appid')).toHaveValue('cli_a1b2c3d4e5f60718');
    expect(screen.getByTestId('feishu-enabled')).toBeChecked();
  });

  it('[edge] hasAppSecret:true makes the secret field show the 已配置 placeholder (never the raw secret)', async () => {
    const client = makeClient({ config: CONFIGURED_VIEW });
    await openImPane(client);

    const secret = await screen.findByTestId('feishu-appsecret');
    expect(secret).toHaveValue(''); // the masked view carries no secret
    expect(secret).toHaveAttribute('placeholder', expect.stringContaining('已配置'));
  });

  it('[edge] a never-configured view leaves appId empty, the checkbox unchecked, placeholder NOT 已配置', async () => {
    const client = makeClient({ config: EMPTY_FEISHU_VIEW });
    await openImPane(client);

    expect(await screen.findByTestId('feishu-appid')).toHaveValue('');
    expect(screen.getByTestId('feishu-enabled')).not.toBeChecked();
    expect(screen.getByTestId('feishu-appsecret')).toHaveAttribute(
      'placeholder',
      expect.not.stringContaining('已配置'),
    );
  });

  it('[edge] a connected status paints the badge data-connected="true"', async () => {
    const client = makeClient({ config: CONFIGURED_VIEW, connected: true });
    await openImPane(client);

    const badge = await screen.findByTestId('feishu-connected');
    expect(badge).toHaveAttribute('data-connected', 'true');
  });

  it('[edge] a disconnected status paints the badge data-connected="false"', async () => {
    const client = makeClient({ config: CONFIGURED_VIEW, connected: false });
    await openImPane(client);

    const badge = await screen.findByTestId('feishu-connected');
    expect(badge).toHaveAttribute('data-connected', 'false');
  });
});

describe('FeishuSection — save semantics (happy + adversarial)', () => {
  it('[happy] filling appId, enabling, and typing a secret sends ALL of them incl. the secret', async () => {
    const client = makeClient({ config: EMPTY_FEISHU_VIEW });
    await openImPane(client);
    await screen.findByTestId('feishu-appid');

    await userEvent.type(screen.getByTestId('feishu-appid'), 'cli_9f8e7d6c5b4a3210');
    await userEvent.click(screen.getByTestId('feishu-enabled'));
    await userEvent.type(screen.getByTestId('feishu-appsecret'), 'kP9rXq2Lm7Bc4Df1Gh5Jk8Np0Qr6St3');
    await userEvent.click(screen.getByTestId('feishu-save'));

    await waitFor(() => expect(client.setFeishuConfig).toHaveBeenCalledTimes(1));
    expect(client.setFeishuConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'cli_9f8e7d6c5b4a3210',
        enabled: true,
        appSecret: 'kP9rXq2Lm7Bc4Df1Gh5Jk8Np0Qr6St3',
      }),
    );
  });

  it('[adversarial] leaving the secret field blank OMITS appSecret from the patch (never clears a stored secret)', async () => {
    // Editing an already-configured app without re-typing the secret must NOT clear it:
    // a blank field means "leave the stored secret as-is" → the PUT must omit appSecret
    // entirely (an empty string would CLEAR it on the store).
    const client = makeClient({ config: CONFIGURED_VIEW });
    await openImPane(client);
    await screen.findByTestId('feishu-appid');

    await userEvent.clear(screen.getByTestId('feishu-appid'));
    await userEvent.type(screen.getByTestId('feishu-appid'), 'cli_rotated_000000001');
    await userEvent.click(screen.getByTestId('feishu-save'));

    await waitFor(() => expect(client.setFeishuConfig).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(client.setFeishuConfig).mock.calls[0]?.[0] ?? {};
    expect(arg).toEqual(
      expect.objectContaining({ appId: 'cli_rotated_000000001', enabled: true }),
    );
    expect('appSecret' in arg).toBe(false);
  });

  it('[adversarial] the appSecret input is type="password" (not rendered in cleartext)', async () => {
    const client = makeClient({ config: CONFIGURED_VIEW });
    await openImPane(client);
    expect(await screen.findByTestId('feishu-appsecret')).toHaveAttribute('type', 'password');
  });
});

describe('FeishuSection — failure handling (adversarial)', () => {
  it('[adversarial] setFeishuConfig rejecting surfaces an inline .member-edit-error; the form stays interactive', async () => {
    const client = makeClient({ config: EMPTY_FEISHU_VIEW });
    vi.mocked(client.setFeishuConfig).mockRejectedValue(new Error('飞书配置写入失败：磁盘只读'));
    await openImPane(client);
    await screen.findByTestId('feishu-appid');

    await userEvent.type(screen.getByTestId('feishu-appid'), 'cli_will_fail_00001');
    await userEvent.click(screen.getByTestId('feishu-enabled'));
    await userEvent.type(screen.getByTestId('feishu-appsecret'), 'secret-that-wont-persist-7q');
    await userEvent.click(screen.getByTestId('feishu-save'));

    const err = await screen.findByText('飞书配置写入失败：磁盘只读');
    expect(err).toHaveClass('member-edit-error');
    // The section + save button are still mounted and usable after the rejected save.
    expect(screen.getByTestId('feishu-section')).toBeInTheDocument();
    expect(screen.getByTestId('feishu-save')).toBeEnabled();
  });

  it('[adversarial] getFeishuConfig rejecting at mount shows the loading/error state without crashing the pane', async () => {
    // A flaky config probe must degrade gracefully — the section renders its
    // fallback (cfg===null branch shows 加载失败/加载中) and never an empty/crashed tab.
    const client = makeClient({ config: EMPTY_FEISHU_VIEW });
    vi.mocked(client.getFeishuConfig).mockRejectedValue(new Error('飞书配置加载失败 503'));
    await openImPane(client);

    // The section is still mounted; its fallback surfaces the error and no form is shown.
    const section = await screen.findByTestId('feishu-section');
    expect(section).toHaveTextContent('飞书配置加载失败 503');
    expect(screen.queryByTestId('feishu-save')).not.toBeInTheDocument();
  });
});
