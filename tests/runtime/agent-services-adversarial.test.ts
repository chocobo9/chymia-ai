// QA edge/adversarial — runtime provider wiring (buildAgentServicesFromRoster,
// resolvePermissionMode). Authored by a QA instance that did NOT write the product
// code (CLAUDE.md §0.5.3 dev≠QA). The dev's happy-path suite covers the clientId→
// provider mapping and the default/explicit permission mode. This file HUNTS:
//   - malformed / hostile rosters (unmapped clientId, empty, duplicate ids, missing file)
//   - the frozen-record immutability guarantee (mutation must throw)
//   - resolvePermissionMode across ALL valid modes + every invalid shape (fail-fast)
//
// Rosters are written to OS temp files (no repo litter) and fed via agentsConfigPath.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAgentServicesFromRoster,
  resolvePermissionMode,
  CHOCO_DEFAULT_PERMISSION_MODE,
} from '@clowder/api/runtime/agent-services';
import { ClaudeAgentService } from '@clowder/api/providers/claude/claude-service';
import { CodexAgentService } from '@clowder/api/providers/codex/codex-service';
import { GeminiAgentService } from '@clowder/api/providers/gemini/gemini-service';

// ── Temp-roster fixtures (cleaned up afterEach; no repo litter) ────────────────
const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Write a roster YAML to a fresh temp dir and return its absolute path. */
function writeRoster(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'choco-roster-'));
  tmpDirs.push(dir);
  const path = join(dir, 'agents.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

/** A realistic single-agent roster block, parameterized by id + clientId. */
function agentBlock(id: string, clientId: string, model: string): string {
  return [
    `  - id: ${id}`,
    `    name: 测试猫`,
    `    displayName: ${id}`,
    `    clientId: ${clientId}`,
    `    defaultModel: ${model}`,
    `    mcpSupport: true`,
    `    mentionPatterns: ['@${id}']`,
    `    personality: 务实、稳健。`,
    `    roleDescription: 测试用 agent。`,
    `    color:`,
    `      primary: '#6366f1'`,
    `      secondary: '#818cf8'`,
  ].join('\n');
}

describe('buildAgentServicesFromRoster — hostile roster shapes (adversarial)', () => {
  it('REJECTS a roster carrying an unmapped/typo clientId at load time (fail-fast, no half-wired registry)', () => {
    // The realistic path to an "unmapped clientId" is a hand-edited roster. The
    // loader's zod enum (agent-config-loader.ts: z.enum(['anthropic','openai',
    // 'google'])) must reject it BEFORE buildServiceForClient is ever reached — so
    // a 4th clientId can never produce an `undefined` service that crashes invoke.
    const roster = `agents:\n${agentBlock('claude-opus', 'anthropic', 'claude-opus-4-6')}\n${agentBlock('mystery-bot', 'mistral', 'mistral-large')}`;
    const path = writeRoster(roster);

    expect(() => buildAgentServicesFromRoster({ agentsConfigPath: path })).toThrow();
  });

  it('REJECTS an empty roster (zod agents.min(1)) rather than returning an empty service map', () => {
    const path = writeRoster('agents: []');
    expect(() => buildAgentServicesFromRoster({ agentsConfigPath: path })).toThrow();
  });

  it('REJECTS a roster file that does not exist (readFileSync ENOENT propagates)', () => {
    const bogus = join(tmpdir(), 'choco-roster-does-not-exist', 'agents.yaml');
    expect(() => buildAgentServicesFromRoster({ agentsConfigPath: bogus })).toThrow();
  });

  it('REJECTS structurally malformed YAML (not the {agents: [...]} shape)', () => {
    const path = writeRoster('this: is\nnot: a roster\n');
    expect(() => buildAgentServicesFromRoster({ agentsConfigPath: path })).toThrow();
  });

  it('with DUPLICATE agent ids the record collapses to one entry per id (later wins) and stays runnable', () => {
    // zod does not forbid duplicate ids; the service map is keyed by id, so a
    // duplicate id overwrites. Confirm the behavior is deterministic (last wins)
    // and the surviving entry is a real, runnable service — not a crash.
    const roster = `agents:\n${agentBlock('dup-agent', 'anthropic', 'claude-opus-4-6')}\n${agentBlock('dup-agent', 'openai', 'gpt-4.1')}`;
    const path = writeRoster(roster);

    const services = buildAgentServicesFromRoster({ agentsConfigPath: path });
    expect(Object.keys(services)).toEqual(['dup-agent']);
    // Last block (openai) wins → CodexAgentService.
    expect(services['dup-agent']).toBeInstanceOf(CodexAgentService);
    expect(typeof services['dup-agent']?.invoke).toBe('function');
  });

  it('a single-agent roster of EACH client builds the matching provider in isolation', () => {
    const anthropic = buildAgentServicesFromRoster({
      agentsConfigPath: writeRoster(`agents:\n${agentBlock('solo-claude', 'anthropic', 'claude-opus-4-6')}`),
    });
    const openai = buildAgentServicesFromRoster({
      agentsConfigPath: writeRoster(`agents:\n${agentBlock('solo-codex', 'openai', 'gpt-4.1')}`),
    });
    const google = buildAgentServicesFromRoster({
      agentsConfigPath: writeRoster(`agents:\n${agentBlock('solo-gemini', 'google', 'gemini-2.5-pro')}`),
    });

    expect(anthropic['solo-claude']).toBeInstanceOf(ClaudeAgentService);
    expect(openai['solo-codex']).toBeInstanceOf(CodexAgentService);
    expect(google['solo-gemini']).toBeInstanceOf(GeminiAgentService);
  });

  it('one bad agent in an otherwise-valid roster fails the WHOLE build (all-or-nothing), leaving no partially-wired map', () => {
    // anthropic is valid, the second agent has an unmapped clientId. The loader
    // validates the whole roster, so the valid agent must NOT leak out as a
    // half-wired registry — the entire build throws.
    const roster = `agents:\n${agentBlock('good-claude', 'anthropic', 'claude-opus-4-6')}\n${agentBlock('bad-one', 'cohere', 'command-r')}`;
    const path = writeRoster(roster);
    expect(() => buildAgentServicesFromRoster({ agentsConfigPath: path })).toThrow();
  });
});

describe('buildAgentServicesFromRoster — frozen immutability (edge)', () => {
  it('the returned record is frozen: assigning a new key throws in strict mode', () => {
    const services = buildAgentServicesFromRoster();
    expect(Object.isFrozen(services)).toBe(true);
    // ESM modules are strict mode → writing to a frozen object throws TypeError.
    expect(() => {
      (services as Record<string, unknown>)['injected-rogue'] = {};
    }).toThrow(TypeError);
  });

  it('the returned record is frozen: overwriting an existing key throws in strict mode', () => {
    const services = buildAgentServicesFromRoster();
    expect(() => {
      (services as Record<string, unknown>)['claude-opus'] = {};
    }).toThrow(TypeError);
  });

  it('the returned record is frozen: deleting a key throws in strict mode', () => {
    const services = buildAgentServicesFromRoster();
    expect(() => {
      delete (services as Record<string, unknown>)['claude-opus'];
    }).toThrow(TypeError);
  });
});

describe('buildAgentServicesFromRoster — permissionMode pass-through (edge)', () => {
  it('forwards an explicit permissionMode to the Claude provider without throwing for every valid mode', () => {
    // The composition root narrows CHOCO_PERMISSION_MODE; the factory must accept
    // each of the 6 valid Claude modes and still produce a Claude service.
    for (const mode of [
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ] as const) {
      const services = buildAgentServicesFromRoster({ permissionMode: mode });
      expect(services['claude-opus']).toBeInstanceOf(ClaudeAgentService);
    }
  });
});

describe('resolvePermissionMode — fail-fast on bad input (adversarial)', () => {
  it('falls back to the documented default ONLY for undefined (unset env)', () => {
    expect(resolvePermissionMode(undefined)).toBe(CHOCO_DEFAULT_PERMISSION_MODE);
    expect(CHOCO_DEFAULT_PERMISSION_MODE).toBe('acceptEdits');
  });

  it('accepts every one of the 6 valid Claude modes verbatim', () => {
    for (const mode of [
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ]) {
      expect(resolvePermissionMode(mode)).toBe(mode);
    }
  });

  it('THROWS (does not silently default) on the empty string — "" is not undefined, so ?? does not rescue it', () => {
    // Critical safety property: an empty CHOCO_PERMISSION_MODE must NOT silently
    // become the default (which could mask a misconfiguration / downgrade the
    // sandbox). assertValidPermissionMode rejects '' explicitly.
    expect(() => resolvePermissionMode('')).toThrow(/Invalid Claude permission mode/);
  });

  it('THROWS on whitespace-only input (no trimming)', () => {
    expect(() => resolvePermissionMode('   ')).toThrow(/Invalid Claude permission mode/);
  });

  it('THROWS on a typo of a real mode (no fuzzy matching)', () => {
    expect(() => resolvePermissionMode('acceptEdit')).toThrow(/Invalid Claude permission mode/);
    expect(() => resolvePermissionMode('plna')).toThrow(/Invalid Claude permission mode/);
  });

  it('THROWS on wrong casing — modes are case-sensitive', () => {
    expect(() => resolvePermissionMode('AcceptEdits')).toThrow(/Invalid Claude permission mode/);
    expect(() => resolvePermissionMode('PLAN')).toThrow(/Invalid Claude permission mode/);
    expect(() => resolvePermissionMode('Default')).toThrow(/Invalid Claude permission mode/);
  });

  it('THROWS on outright garbage and on padded-but-otherwise-valid values', () => {
    expect(() => resolvePermissionMode('rm -rf /')).toThrow(/Invalid Claude permission mode/);
    expect(() => resolvePermissionMode('acceptEdits ')).toThrow(/Invalid Claude permission mode/);
    expect(() => resolvePermissionMode(' plan')).toThrow(/Invalid Claude permission mode/);
  });

  it('the thrown error names the offending value AND lists the allowed modes (operator-friendly)', () => {
    expect(() => resolvePermissionMode('yolo')).toThrow(/"yolo"/);
    expect(() => resolvePermissionMode('yolo')).toThrow(/acceptEdits, auto, bypassPermissions, default, dontAsk, plan/);
  });
});
