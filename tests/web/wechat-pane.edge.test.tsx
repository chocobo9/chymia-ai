// @vitest-environment jsdom
//
// IM 对接 (WeChatPane) — web gate for the WeCom adapter settings pane the dev wired
// into SettingsOverlay (a NEW `im` nav tab). Authored by the INDEPENDENT QA instance
// (dev≠QA, §0.5.3): the dev shipped happy-path wiring; this file is the edge +
// adversarial gate. NO product code modified (tests/ only).
//
// Renders <SettingsOverlay> directly (accounts-pane.edge.test.tsx pattern), navigates
// to the IM 对接 pane via its nav testid, and drives a REAL ApiClient whose fetch is
// stubbed to reject — getWeChatConfig/setWeChatConfig are spied so we assert the
// prefill contract, the ready flag, the masked-secret discipline (write-only,
// omitted-when-blank), and the inline error path.
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

// Realistic WeCom self-built-app config (corpId / callback token / api base). The
// secret is never in the masked view — only hasSecret.
const CONFIGURED_READY: WeChatSettingsView = {
  corpId: 'ww8f1a2b3c4d5e6f70',
  agentId: '1000002',
  token: 'choco-wecom-callback-7Hq2',
  apiBase: DEFAULT_API_BASE,
  enabled: true,
  hasSecret: true,
  hasEncodingAesKey: true,
  webhookPath: WEBHOOK_PATH,
  ready: true,
};

/** An empty/never-configured masked view (the first-run state). */
const EMPTY_VIEW: WeChatSettingsView = {
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

function makeClient(view: WeChatSettingsView): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  // Mount lands on 成员管理 — it needs the roster catalog.
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'getWeChatConfig').mockResolvedValue(view);
  // setWeChatConfig echoes a masked view by default (overridden per-test).
  vi.spyOn(client, 'setWeChatConfig').mockResolvedValue(view);
  return client;
}

/** Render the overlay and click into the IM 对接 pane (by its nav label). */
async function openWeChatPane(client: ApiClient): Promise<void> {
  render(
    <SettingsOverlay
      onClose={vi.fn()}
      client={client}
      health={{ state: 'ok' } as HealthInfo}
      socketConnected
    />,
  );
  await userEvent.click(screen.getByRole('tab', { name: 'IM 对接' }));
  await waitFor(() => expect(client.getWeChatConfig).toHaveBeenCalled());
  await screen.findByTestId('wechat-form');
}

beforeEach(() => useAgentStore.setState({ roster: ROSTER, statusById: {} }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WeChatPane — prefill from the masked config (happy + edge)', () => {
  it('[happy] a configured view prefills corpId/token/apiBase, the enabled checkbox, and the webhook path', async () => {
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    expect(screen.getByTestId('wechat-corpid')).toHaveValue('ww8f1a2b3c4d5e6f70');
    expect(screen.getByTestId('wechat-token')).toHaveValue('choco-wecom-callback-7Hq2');
    expect(screen.getByTestId('wechat-apibase')).toHaveValue(DEFAULT_API_BASE);
    expect(screen.getByTestId('wechat-enabled')).toBeChecked();
    // The webhook path WeCom must call is rendered for the operator.
    expect(screen.getByTestId('wechat-webhook-path')).toHaveTextContent(WEBHOOK_PATH);
  });

  it('[edge] the wechat-agentid input renders and prefills from the view (required for message/send)', async () => {
    // The agentId field is the UI half of the reply-back fix: WeCom message/send is
    // rejected (errcode 92000) without the self-built app's AgentId. The pane must
    // surface it and prefill it from the masked view so an operator can configure it.
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    const agentIdInput = screen.getByTestId('wechat-agentid');
    expect(agentIdInput).toHaveValue('1000002');
    // The placeholder guides operators to the numeric self-built-app AgentId.
    expect(agentIdInput).toHaveAttribute('placeholder', expect.stringContaining('AgentId'));
  });

  it('[edge] a never-configured view leaves the agentId input empty', async () => {
    const client = makeClient(EMPTY_VIEW);
    await openWeChatPane(client);
    expect(screen.getByTestId('wechat-agentid')).toHaveValue('');
  });

  it('[edge] hasSecret:true makes the secret field placeholder indicate 已配置 (not the raw secret)', async () => {
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);
    const secret = screen.getByTestId('wechat-secret');
    // The masked view carries NO secret — the field is empty, only the placeholder
    // signals that one is stored ("已配置").
    expect(secret).toHaveValue('');
    expect(secret).toHaveAttribute('placeholder', expect.stringContaining('已配置'));
  });

  it('[edge] a never-configured view leaves the inputs empty, the checkbox unchecked, and the secret placeholder NOT 已配置', async () => {
    const client = makeClient(EMPTY_VIEW);
    await openWeChatPane(client);
    expect(screen.getByTestId('wechat-corpid')).toHaveValue('');
    expect(screen.getByTestId('wechat-token')).toHaveValue('');
    expect(screen.getByTestId('wechat-enabled')).not.toBeChecked();
    expect(screen.getByTestId('wechat-secret')).toHaveAttribute(
      'placeholder',
      expect.not.stringContaining('已配置'),
    );
  });
});

describe('WeChatPane — ready flag reflects the view (edge)', () => {
  it('[edge] a ready view paints wechat-ready data-ready="true"', async () => {
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);
    expect(screen.getByTestId('wechat-ready')).toHaveAttribute('data-ready', 'true');
  });

  it('[edge] a not-ready view (enabled but no secret) paints data-ready="false"', async () => {
    const client = makeClient({
      ...CONFIGURED_READY,
      hasSecret: false,
      ready: false,
    });
    await openWeChatPane(client);
    expect(screen.getByTestId('wechat-ready')).toHaveAttribute('data-ready', 'false');
  });
});

describe('WeChatPane — save semantics (happy + adversarial)', () => {
  it('[happy] filling corpId/agentId/token, toggling enabled, and typing a secret sends ALL of them incl. the secret', async () => {
    const client = makeClient(EMPTY_VIEW);
    await openWeChatPane(client);

    await userEvent.type(screen.getByTestId('wechat-corpid'), 'ww1234567890abcdef');
    await userEvent.type(screen.getByTestId('wechat-agentid'), '1000002');
    await userEvent.type(screen.getByTestId('wechat-token'), 'cb-token-Zx91');
    await userEvent.click(screen.getByTestId('wechat-enabled'));
    await userEvent.type(screen.getByTestId('wechat-secret'), 'live-app-secret-Qa83Lm0PpZ');
    await userEvent.click(screen.getByTestId('wechat-save'));

    await waitFor(() => expect(client.setWeChatConfig).toHaveBeenCalledTimes(1));
    expect(client.setWeChatConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'ww1234567890abcdef',
        agentId: '1000002',
        token: 'cb-token-Zx91',
        enabled: true,
        secret: 'live-app-secret-Qa83Lm0PpZ',
      }),
    );
  });

  it('[edge] editing the agentId sends the NEW value in the patch (the reply-back fix is operator-settable)', async () => {
    // Rotating the self-built app means a new AgentId; saving must carry the typed
    // value so message/send targets the right app.
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    await userEvent.clear(screen.getByTestId('wechat-agentid'));
    await userEvent.type(screen.getByTestId('wechat-agentid'), '1000009');
    await userEvent.click(screen.getByTestId('wechat-save'));

    await waitFor(() => expect(client.setWeChatConfig).toHaveBeenCalledTimes(1));
    expect(client.setWeChatConfig).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: '1000009' }),
    );
  });

  it('[adversarial] leaving the secret field blank OMITS secret from the patch (never sends an empty string)', async () => {
    // Editing an already-configured app without re-typing the secret must NOT
    // clear it: a blank secret field means "leave the stored secret as-is", so the
    // PUT must omit the `secret` key entirely (an empty string would CLEAR it). The
    // prefilled agentId must still ride along in the patch.
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    await userEvent.clear(screen.getByTestId('wechat-corpid'));
    await userEvent.type(screen.getByTestId('wechat-corpid'), 'ww-rotated-corp-0001');
    await userEvent.click(screen.getByTestId('wechat-save'));

    await waitFor(() => expect(client.setWeChatConfig).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(client.setWeChatConfig).mock.calls[0]?.[0] ?? {};
    expect(arg).toEqual(
      expect.objectContaining({ corpId: 'ww-rotated-corp-0001', agentId: '1000002', enabled: true }),
    );
    expect('secret' in arg).toBe(false);
  });

  it('[adversarial] the secret input is type="password" (not rendered in cleartext)', async () => {
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);
    expect(screen.getByTestId('wechat-secret')).toHaveAttribute('type', 'password');
  });
});

describe('WeChatPane — EncodingAESKey input + warning (edge + adversarial)', () => {
  it('[edge] the wechat-aeskey input renders as a password field (the key is a secret)', async () => {
    // The EncodingAESKey decrypts WeCom callbacks — it is write-only, masked like the
    // app secret. The masked view never carries it (only hasEncodingAesKey).
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    const aeskey = screen.getByTestId('wechat-aeskey');
    expect(aeskey).toHaveAttribute('type', 'password');
    expect(aeskey).toHaveValue(''); // the key itself is never prefilled
    // The placeholder steers operators to the 43-char EncodingAESKey requirement.
    expect(aeskey).toHaveAttribute('placeholder', expect.stringContaining('EncodingAESKey'));
  });

  it('[edge] typing a 43-char EncodingAESKey sends it in the patch (encrypted mode becomes configurable)', async () => {
    // A realistic 43-char EncodingAESKey (32 bytes base64, trailing '=' stripped) — the
    // WeCom shape. Saving must carry it so the adapter can derive the AES key.
    const aesKey = Buffer.alloc(32, 7).toString('base64').replace(/=$/, '');
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    await userEvent.type(screen.getByTestId('wechat-aeskey'), aesKey);
    await userEvent.click(screen.getByTestId('wechat-save'));

    await waitFor(() => expect(client.setWeChatConfig).toHaveBeenCalledTimes(1));
    expect(client.setWeChatConfig).toHaveBeenCalledWith(
      expect.objectContaining({ encodingAesKey: aesKey }),
    );
  });

  it('[adversarial] leaving the aeskey field blank OMITS encodingAesKey from the patch (never clears a stored key)', async () => {
    // Editing a configured app without re-typing the EncodingAESKey must NOT clear it:
    // a blank field means "leave the stored key as-is", so the PUT must omit the key
    // entirely (an empty string would CLEAR it on the store).
    const client = makeClient(CONFIGURED_READY);
    await openWeChatPane(client);

    await userEvent.clear(screen.getByTestId('wechat-corpid'));
    await userEvent.type(screen.getByTestId('wechat-corpid'), 'ww-rotated-corp-0002');
    await userEvent.click(screen.getByTestId('wechat-save'));

    await waitFor(() => expect(client.setWeChatConfig).toHaveBeenCalledTimes(1));
    const arg = vi.mocked(client.setWeChatConfig).mock.calls[0]?.[0] ?? {};
    expect('encodingAesKey' in arg).toBe(false);
  });

  it('[edge] a ready view WITHOUT an EncodingAESKey shows the wechat-aeskey-warning', async () => {
    // ready:true but hasEncodingAesKey:false = the operator finished basic config but
    // WeCom's encrypted callbacks will be undecryptable — the pane must warn loudly.
    const client = makeClient({ ...CONFIGURED_READY, hasEncodingAesKey: false });
    await openWeChatPane(client);

    const warning = screen.getByTestId('wechat-aeskey-warning');
    expect(warning).toBeInTheDocument();
    expect(warning).toHaveTextContent('EncodingAESKey');
  });

  it('[edge] a ready view WITH an EncodingAESKey hides the warning', async () => {
    const client = makeClient({ ...CONFIGURED_READY, hasEncodingAesKey: true });
    await openWeChatPane(client);
    expect(screen.queryByTestId('wechat-aeskey-warning')).not.toBeInTheDocument();
  });

  it('[adversarial] a NOT-ready view does NOT show the aeskey warning even without a key (warning is ready-gated)', async () => {
    // The warning only makes sense once the rest is ready; a half-configured (not ready)
    // view must NOT nag about the missing EncodingAESKey yet.
    const client = makeClient({ ...EMPTY_VIEW, hasEncodingAesKey: false });
    await openWeChatPane(client);
    expect(screen.queryByTestId('wechat-aeskey-warning')).not.toBeInTheDocument();
  });
});

describe('WeChatPane — failure handling (adversarial)', () => {
  it('[adversarial] setWeChatConfig rejecting surfaces an inline .member-edit-error and does not crash the pane', async () => {
    const client = makeClient(EMPTY_VIEW);
    vi.mocked(client.setWeChatConfig).mockRejectedValue(new Error('配置写入失败：磁盘只读'));
    await openWeChatPane(client);

    await userEvent.type(screen.getByTestId('wechat-corpid'), 'ww-will-fail-0000');
    await userEvent.type(screen.getByTestId('wechat-token'), 'cb-fail-token');
    await userEvent.type(screen.getByTestId('wechat-secret'), 'secret-that-wont-persist');
    await userEvent.click(screen.getByTestId('wechat-save'));

    const err = await screen.findByText('配置写入失败：磁盘只读');
    expect(err).toHaveClass('member-edit-error');
    // The form is still mounted + interactive after the rejected save.
    expect(screen.getByTestId('wechat-form')).toBeInTheDocument();
    expect(screen.getByTestId('wechat-save')).toBeEnabled();
  });
});
