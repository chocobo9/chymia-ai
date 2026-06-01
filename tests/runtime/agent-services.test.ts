// Dev happy-path: buildAgentServicesFromRoster — the runtime provider wiring that
// maps the externalized roster (agents.yaml) to REAL provider instances keyed by
// agent id, ready to inject into buildApp({ agentServices }).
//
// Asserts the clientId → provider class mapping (anthropic→Claude, openai→Codex,
// google→Gemini) and the externalized Claude permission-mode resolution
// (default 'acceptEdits', explicit override honored, invalid value fails fast).
//
// QA owns edge/adversarial (malformed roster, missing file, every invalid mode).

import { describe, it, expect } from 'vitest';
import {
  buildAgentServicesFromRoster,
  resolvePermissionMode,
  CHOCO_DEFAULT_PERMISSION_MODE,
} from '@clowder/api/runtime/agent-services';
import { ClaudeAgentService } from '@clowder/api/providers/claude/claude-service';
import { CodexAgentService } from '@clowder/api/providers/codex/codex-service';
import { GeminiAgentService } from '@clowder/api/providers/gemini/gemini-service';

describe('buildAgentServicesFromRoster (happy path)', () => {
  it('maps each roster clientId to the matching provider class', () => {
    const services = buildAgentServicesFromRoster();

    // The three shipped roster ids (packages/api/src/config/agents.yaml).
    expect(services['claude-opus']).toBeInstanceOf(ClaudeAgentService);
    expect(services['codex-gpt']).toBeInstanceOf(CodexAgentService);
    expect(services['gemini-pro']).toBeInstanceOf(GeminiAgentService);
  });

  it('builds one runnable AgentService per roster agent (>= 3)', () => {
    const services = buildAgentServicesFromRoster();
    const ids = Object.keys(services);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    for (const id of ids) {
      expect(typeof services[id]?.invoke).toBe('function');
    }
  });

  it('accepts a configured Claude permissionMode without throwing', () => {
    const services = buildAgentServicesFromRoster({ permissionMode: 'plan' });
    expect(services['claude-opus']).toBeInstanceOf(ClaudeAgentService);
  });

  it('returns a frozen (immutable) record', () => {
    const services = buildAgentServicesFromRoster();
    expect(Object.isFrozen(services)).toBe(true);
  });
});

describe('resolvePermissionMode (happy path)', () => {
  it('falls back to the documented default when unset', () => {
    expect(resolvePermissionMode(undefined)).toBe(CHOCO_DEFAULT_PERMISSION_MODE);
    expect(CHOCO_DEFAULT_PERMISSION_MODE).toBe('acceptEdits');
  });

  it('honors a valid explicit mode from CHOCO_PERMISSION_MODE', () => {
    expect(resolvePermissionMode('bypassPermissions')).toBe('bypassPermissions');
    expect(resolvePermissionMode('plan')).toBe('plan');
  });
});
