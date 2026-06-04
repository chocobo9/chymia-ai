// @vitest-environment jsdom
//
// WeixinSection (个人微信 扫码登录) — web EDGE + ADVERSARIAL gate for the personal-WeChat
// (iLink) login pane the dev wired into SettingsOverlay's IM 对接 tab (ABOVE the WeCom
// form). Authored by the INDEPENDENT QA instance (dev≠QA, §0.5.3): the dev shipped the
// happy-path component; this file drives a REAL ApiClient (weixin* methods spied) through
// every UI branch — status-driven initial render, the scan→QR→poll→confirm flip, logout,
// and the login-failure inline error. NO product code modified (tests/ only).
//
// The qrcode lib renders a real PNG data URL headless (string input → pure-JS path), so
// the rendered <img data-testid="weixin-qr"> gets a real src. Polling resolves 'confirmed'
// on the FIRST poll so no 2s timer is needed.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WeChatSettingsView } from '@choco/shared';
import { SettingsOverlay } from '../../packages/web/src/components/overlays/SettingsOverlay.js';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import type { HealthInfo } from '../../packages/web/src/hooks/useHealth.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER } from './fixtures.js';

const WEBHOOK_PATH = '/api/adapters/wechat/webhook';
const DEFAULT_API_BASE = 'https://qyapi.weixin.qq.com';

/** An empty WeCom view — the IM pane needs getWeChatConfig to resolve to mount WeixinSection. */
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

/** A realistic iLink QR challenge (the gateway encodes the opaque payload into the scan URL). */
const QR = {
  qrUrl: 'https://liteapp.weixin.qq.com/ilink/q?qrcode=ILQR_3f9a2c',
  qrPayload: 'ILQR_3f9a2c',
} as const;

interface WeixinStubs {
  readonly connected?: boolean;
  readonly hasToken?: boolean;
}

/**
 * A real ApiClient whose raw fetch rejects (nothing should hit the wire); the weixin*
 * AND wechat methods are spied so we drive the component deterministically.
 */
function makeClient(weixin: WeixinStubs = {}): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  // Mount lands on 成员管理 (roster) then we navigate to IM.
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  // The IM pane (WeChatPane) needs a resolved config to render its body incl. WeixinSection.
  vi.spyOn(client, 'getWeChatConfig').mockResolvedValue(EMPTY_WECHAT_VIEW);
  // The WeixinSection seam — default disconnected.
  vi.spyOn(client, 'weixinStatus').mockResolvedValue({
    connected: weixin.connected ?? false,
    hasToken: weixin.hasToken ?? false,
  });
  vi.spyOn(client, 'weixinLoginStart').mockResolvedValue(QR);
  vi.spyOn(client, 'weixinLoginStatus').mockResolvedValue({ status: 'confirmed' });
  vi.spyOn(client, 'weixinLogout').mockResolvedValue(undefined);
  return client;
}

/** Render the overlay and open the IM 对接 pane (WeixinSection sits at its top). */
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
  await screen.findByTestId('weixin-section');
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WeixinSection — status-driven initial render (happy + edge)', () => {
  it('[happy] mounting calls weixinStatus; a disconnected status shows the 扫码登录 button', async () => {
    const client = makeClient({ connected: false });
    await openImPane(client);

    await waitFor(() => expect(client.weixinStatus).toHaveBeenCalled());
    expect(screen.getByTestId('weixin-login')).toBeInTheDocument();
    expect(screen.queryByTestId('weixin-connected')).not.toBeInTheDocument();
  });

  it('[edge] a connected status shows 已连接 + the 退出登录 button (no scan button)', async () => {
    const client = makeClient({ connected: true, hasToken: true });
    await openImPane(client);

    await waitFor(() => expect(screen.getByTestId('weixin-connected')).toBeInTheDocument());
    expect(screen.getByTestId('weixin-logout')).toBeInTheDocument();
    expect(screen.queryByTestId('weixin-login')).not.toBeInTheDocument();
  });
});

describe('WeixinSection — scan → QR → confirm flips to connected (happy + edge)', () => {
  it('[happy] clicking 扫码登录 calls weixinLoginStart and renders a weixin-qr img with a real data-url src', async () => {
    const client = makeClient({ connected: false });
    // Hold the poll at 'waiting' so the rendered QR persists for the assertion (an
    // immediate 'confirmed' would hide the QR before we can observe it — that flip is
    // covered by the next test).
    vi.mocked(client.weixinLoginStatus).mockResolvedValue({ status: 'waiting' });
    await openImPane(client);

    await userEvent.click(screen.getByTestId('weixin-login'));

    await waitFor(() => expect(client.weixinLoginStart).toHaveBeenCalledTimes(1));
    const img = await screen.findByTestId('weixin-qr');
    // The qrcode lib produced a PNG data URL from the iLink scan URL.
    expect(img).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));
  });

  it('[edge] polling resolving "confirmed" flips the section to connected (扫码 → 已连接)', async () => {
    // weixinLoginStatus is stubbed to 'confirmed' on the first poll → no 2s timer needed.
    const client = makeClient({ connected: false });
    await openImPane(client);

    await userEvent.click(screen.getByTestId('weixin-login'));

    // The poll resolves confirmed → the section re-renders into the connected state.
    await waitFor(() => expect(screen.getByTestId('weixin-connected')).toBeInTheDocument());
    expect(client.weixinLoginStatus).toHaveBeenCalledWith(QR.qrPayload);
    expect(screen.queryByTestId('weixin-qr')).not.toBeInTheDocument();
  });
});

describe('WeixinSection — logout (edge)', () => {
  it('[edge] clicking 退出登录 calls weixinLogout and returns to the 扫码登录 state', async () => {
    const client = makeClient({ connected: true, hasToken: true });
    await openImPane(client);

    await waitFor(() => expect(screen.getByTestId('weixin-logout')).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('weixin-logout'));

    await waitFor(() => expect(client.weixinLogout).toHaveBeenCalledTimes(1));
    // Back to disconnected: the scan button reappears, 已连接 is gone.
    expect(await screen.findByTestId('weixin-login')).toBeInTheDocument();
    expect(screen.queryByTestId('weixin-connected')).not.toBeInTheDocument();
  });
});

describe('WeixinSection — failure handling (adversarial)', () => {
  it('[adversarial] weixinLoginStart rejecting surfaces an inline .member-edit-error and does NOT render a QR', async () => {
    const client = makeClient({ connected: false });
    vi.mocked(client.weixinLoginStart).mockRejectedValue(new Error('二维码服务不可用'));
    await openImPane(client);

    await userEvent.click(screen.getByTestId('weixin-login'));

    const err = await screen.findByText('二维码服务不可用');
    expect(err).toHaveClass('member-edit-error');
    // No QR was rendered, and the section is still mounted + the button re-enabled.
    expect(screen.queryByTestId('weixin-qr')).not.toBeInTheDocument();
    expect(screen.getByTestId('weixin-login')).toBeEnabled();
  });

  it('[adversarial] weixinStatus rejecting at mount does not crash the pane (stays disconnected, scan button shown)', async () => {
    // A flaky status probe must degrade silently — the component swallows it and shows
    // the first-run scan UI, never an error or an empty render.
    const client = makeClient({ connected: false });
    vi.mocked(client.weixinStatus).mockRejectedValue(new Error('status probe 503'));
    await openImPane(client);

    // The section rendered; default disconnected state holds.
    expect(screen.getByTestId('weixin-section')).toBeInTheDocument();
    expect(screen.getByTestId('weixin-login')).toBeInTheDocument();
    expect(screen.queryByTestId('weixin-connected')).not.toBeInTheDocument();
  });
});
