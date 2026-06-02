// packages/api/src/runtime/agent-services.ts
// Runtime provider wiring — turn the externalized agent roster (agents.yaml,
// loaded by M8 agent-config-loader) into a Record<id, AgentService> of REAL
// CLI-spawning providers, ready to inject into buildApp({ agentServices }).
//
// This is the missing seam between the static roster and a running server:
// app-factory's resolveAgentServices() registers a config WITHOUT a service as
// "unrunnable" (registry.getService throws). Production must therefore supply a
// real service per agent. We map each roster agent's clientId → provider:
//   anthropic → ClaudeAgentService   (native L0 system prompt, permissionMode)
//   openai    → CodexAgentService
//   google    → GeminiAgentService
//
// CLAUDE.md compliance: no `any`, no console, no default export, no hardcoded
// config (permissionMode comes in via deps from env at the composition root),
// immutability (returns a fresh frozen record), cross-pkg types from @choco/shared.
//
// codex/gemini CLIs may not be installed on the host — that is fine: the provider
// still constructs, and at invocation time cli-spawn surfaces a graceful
// `spawn_error` event (finalizeStream) rather than crashing the server. So we
// wire all three regardless of local CLI availability.

import { createAgentId, type AgentId, type ClientId } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';
import { ClaudeAgentService, assertValidPermissionMode } from '@choco/api/providers/claude/claude-service';
import type { ClaudePermissionMode } from '@choco/api/providers/claude/claude-service';
import { CodexAgentService } from '@choco/api/providers/codex/codex-service';
import { GeminiAgentService } from '@choco/api/providers/gemini/gemini-service';
import { loadAgentConfigs } from '@choco/api/config/agent-config-loader';

/**
 * Documented default Claude permission mode for the running server. Externalized
 * via `CHOCO_PERMISSION_MODE` at the composition root; this is the fallback used
 * when that env var is unset. `'acceptEdits'` auto-applies file edits but still
 * prompts for other tool categories — a safer middle ground than the historical
 * provider-level `'bypassPermissions'` default for a long-running platform.
 * Must be one of {@link PERMISSION_MODES} (validated by assertValidPermissionMode).
 */
export const CHOCO_DEFAULT_PERMISSION_MODE = 'acceptEdits';

/** Dependencies for {@link buildAgentServicesFromRoster}. All optional. */
export interface BuildAgentServicesDeps {
  /**
   * Override the roster YAML path (forwarded to loadAgentConfigs). Defaults to
   * the agents.yaml shipped beside the loader.
   */
  readonly agentsConfigPath?: string;
  /**
   * Claude permission mode (already-validated literal). The composition root
   * reads `CHOCO_PERMISSION_MODE` (a raw string), validates it with
   * assertValidPermissionMode, and passes the narrowed value here. When omitted,
   * {@link resolvePermissionMode} falls back to {@link CHOCO_DEFAULT_PERMISSION_MODE}.
   */
  readonly permissionMode?: ClaudePermissionMode;
  /** Injectable clock forwarded to every provider (deterministic tests). */
  readonly now?: () => number;
}

/**
 * Validate + narrow a raw permission-mode string (e.g. from `CHOCO_PERMISSION_MODE`)
 * to a {@link ClaudePermissionMode}. An UNSET value (`undefined`) falls back to the
 * documented {@link CHOCO_DEFAULT_PERMISSION_MODE}; an explicit-but-invalid value
 * throws (fail-fast) rather than silently downgrading the sandbox.
 *
 * Composition roots call this on the raw env string, then pass the result as
 * {@link BuildAgentServicesDeps.permissionMode}.
 */
export function resolvePermissionMode(raw: string | undefined): ClaudePermissionMode {
  const value = raw ?? CHOCO_DEFAULT_PERMISSION_MODE;
  assertValidPermissionMode(value);
  return value;
}

/**
 * Build a fresh {@link AgentService} for one roster agent, dispatching on its
 * clientId. Pure per-agent factory — no shared mutable state.
 */
function buildServiceForClient(
  clientId: ClientId,
  agentId: AgentId,
  permissionMode: ClaudePermissionMode,
  now: (() => number) | undefined,
): AgentService {
  const common = now !== undefined ? { now } : {};
  switch (clientId) {
    case 'anthropic':
      return new ClaudeAgentService({ agentId, permissionMode, ...common });
    case 'openai':
      return new CodexAgentService({ agentId, ...common });
    case 'google':
      return new GeminiAgentService({ agentId, ...common });
  }
}

/**
 * Load the agent roster and build a real provider per agent, keyed by the roster
 * id (the same id app-factory's registry uses to resolve a service). The returned
 * record is frozen (immutability) so callers cannot mutate the wiring after build.
 *
 * @example
 *   buildApp({ agentServices: buildAgentServicesFromRoster() })
 */
export function buildAgentServicesFromRoster(
  deps: BuildAgentServicesDeps = {},
): Record<string, AgentService> {
  const configs = loadAgentConfigs(deps.agentsConfigPath);
  const permissionMode = deps.permissionMode ?? resolvePermissionMode(undefined);

  const services: Record<string, AgentService> = {};
  for (const config of configs) {
    // config.id is already a branded AgentId; re-brand defensively to keep the
    // factory independent of the loader's exact return typing.
    const agentId = createAgentId(config.id as string);
    services[config.id as string] = buildServiceForClient(
      config.clientId,
      agentId,
      permissionMode,
      deps.now,
    );
  }
  return Object.freeze(services);
}
