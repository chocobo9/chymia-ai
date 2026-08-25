// Dev happy-path: buildAgentServicesFromRoster — the runtime provider wiring that
// maps the externalized roster (agents.yaml) to REAL provider instances keyed by
// agent id, ready to inject into buildApp({ agentServices }).
//
// Asserts the clientId → provider class mapping (anthropic→Claude, openai→Codex,
// google→Antigravity/agy) and the externalized Claude permission-mode resolution
// (default 'acceptEdits', explicit override honored, invalid value fails fast).
//
// QA owns edge/adversarial (malformed roster, missing file, every invalid mode).

import { describe, it, expect } from 'vitest';
import {
  buildAgentServicesFromRoster,
  resolvePermissionMode,
  CHOCO_DEFAULT_PERMISSION_MODE,
} from '@choco/api/runtime/agent-services';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { AntigravityAgentService } from '@choco/api/providers/antigravity/antigravity-service';

describe('buildAgentServicesFromRoster (happy path)', () => {
  it('maps each roster clientId to the matching provider class', () => {
    const services = buildAgentServicesFromRoster();

    // The three shipped roster ids (packages/api/src/config/agents.yaml).
    expect(services['claude-opus']).toBeInstanceOf(ClaudeAgentService);
    expect(services['codex-gpt']).toBeInstanceOf(CodexAgentService);
    expect(services['gemini-pro']).toBeInstanceOf(AntigravityAgentService);
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

describe('buildAgentServicesFromRoster (CLI command overrides — CHOCO_*_CMD)', () => {
  it('forwards a per-client command override to the matching provider (probe + spawn both use cliCommand)', () => {
    const services = buildAgentServicesFromRoster({
      commandByClient: { openai: 'D:\\tools\\codex\\codex.exe' },
    });
    expect(services['codex-gpt']?.cliCommand?.()).toBe('D:\\tools\\codex\\codex.exe');
    // The other clients keep their built-in defaults (only openai was overridden).
    expect(services['claude-opus']?.cliCommand?.()).toBe('claude');
    expect(services['gemini-pro']?.cliCommand?.()).toBe('agy');
  });

  it('[edge] an empty-string override is ignored → provider keeps its default command', () => {
    const services = buildAgentServicesFromRoster({ commandByClient: { openai: '' } });
    expect(services['codex-gpt']?.cliCommand?.()).toBe('codex');
  });

  it('[edge] no commandByClient → every provider uses its default command', () => {
    const services = buildAgentServicesFromRoster();
    expect(services['claude-opus']?.cliCommand?.()).toBe('claude');
    expect(services['codex-gpt']?.cliCommand?.()).toBe('codex');
    expect(services['gemini-pro']?.cliCommand?.()).toBe('agy');
  });

  it('[regression] ignores a stale google command override pointing at the old gemini CLI', () => {
    const services = buildAgentServicesFromRoster({ commandByClient: { google: 'gemini' } });
    expect(services['gemini-pro']?.cliCommand?.()).toBe('agy');
  });

  it('[regression] ignores a stale absolute google command override pointing at gemini.exe', () => {
    const services = buildAgentServicesFromRoster({
      commandByClient: { google: 'D:\\tools\\gemini\\gemini.exe' },
    });
    expect(services['gemini-pro']?.cliCommand?.()).toBe('agy');
  });

  it('[regression] forwards the resolved agy executable path so invocation does not spawn a stale bare PATH command', () => {
    const agyPath = 'C:\\Users\\zihan\\AppData\\Local\\agy\\bin\\agy.exe';
    const services = buildAgentServicesFromRoster({
      commandResolver: (command) => (command === 'agy' ? agyPath : undefined),
    });
    expect(services['gemini-pro']?.cliCommand?.()).toBe(agyPath);
  });

  it('[regression] stale google=gemini override still falls through to the resolved agy executable path', () => {
    const agyPath = 'C:\\Users\\zihan\\AppData\\Local\\agy\\bin\\agy.exe';
    const services = buildAgentServicesFromRoster({
      commandByClient: { google: 'gemini' },
      commandResolver: (command) => (command === 'agy' ? agyPath : undefined),
    });
    expect(services['gemini-pro']?.cliCommand?.()).toBe(agyPath);
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
