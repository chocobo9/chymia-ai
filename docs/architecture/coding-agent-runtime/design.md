# Coding Agent Runtime Design

> Status: **Canonical target-module draft — under design review**
> Created: 2026-07-26
> Domain terms: [Coding Agent CLI, Agent Profile, Session, Agent Invocation](../../domain/CONTEXT.md)
> Evidence: current production invokes provider-specific CLIs through
> `AgentService.invoke` and `invokeSingleAgent`. [CODE-CONFIRMED]

## 1. Meaning and provenance

`Coding Agent Runtime` is an infrastructure Module, not a domain object. It
turns one prepared Agent Invocation into normalized observations about one real
Coding Agent CLI.

The earlier name `Agent Execution` was too broad: it could mean the entire Run,
the orchestration lifecycle, or the CLI process. `Runtime` is used narrowly for
provider-specific executable discovery, process/protocol control, Session
continuity, stream normalization, cancellation, and liveness reconciliation.

`Harness` is not a Module and is no longer ubiquitous language. It was a loose
umbrella for orchestration, permissions, repository rules, evaluation, audit,
and recovery. Some of those controls surround the Runtime, but their state
belongs to the Modules responsible for them.

## 2. Why this is a Module

Deleting this Module would spread executable lookup, provider flags,
stdin/stdout protocol, stream parsing, process-tree cancellation, resume
identifiers, and provider error classification into Work Orchestration and
every caller. That complexity does not disappear.

The Interface has Depth because callers request one CLI activation and receive
normalized facts without knowing Codex or Antigravity protocol details. It
provides Leverage to Work Orchestration and concentrates provider bugs in one
Implementation.

The true-external CLI seam is real: Codex and Google Antigravity are distinct
production Adapters. Claude Code and Gemini are current implementation evidence,
not target defaults.

## 3. Authoritative state

| State | Meaning | Persistence | Recovery |
|---|---|---|---|
| Session | Provider continuity reference and usability state for one Agent Profile in one Thread | SQLite | Re-prove continuity; unprovable continuity becomes lost, never silently recreated |
| Session-use generation | Exclusive use of a Session by one Agent Invocation | SQLite | Expire/fence stale use before another Invocation resumes the Session |
| Runtime handle record | Provider/process locator and capability facts needed to cancel or reconcile one activation | SQLite where safely persistable; live OS handle remains process-local | Re-prove identity after restart; return unknown when it cannot be proved |

An Agent Profile is configuration supplied to the Runtime. An Agent Invocation
and its terminal lifecycle are maintained by Work Orchestration. Normalized runtime
observations are outputs, not a second copy of Invocation state.

## 4. Interface

```ts
interface CodingAgentRuntime {
  discover(profile: AgentProfileRef): Promise<RuntimeCapabilities>;
  start(spec: PreparedInvocation): Promise<RuntimeHandle>;
  cancel(request: CancelRuntimeHandle): Promise<CancelObservation>;
  reconcile(handle: RuntimeHandleRef): Promise<RuntimeObservation>;
}
```

| Operation | Caller must supply | Result | Errors and idempotency |
|---|---|---|---|
| `discover` | Agent Profile and permitted executable lookup scope | observed executable/version/capabilities | unavailable, unauthenticated, misconfigured, incompatible; observation has a timestamp |
| `start` | Invocation ID, profile, context, optional Session, Project Access handle, Authorization Grant, deadline/budget, event sink identity, idempotency key | Runtime handle and normalized start/event stream | duplicate compatible request returns/reconciles original handle; conflicting duplicate is rejected before spawn |
| `cancel` | handle, Invocation ID, reason | requested, already terminal, not found, or unknown observation | repeated cancellation is safe; it cannot address another Invocation by Thread or profile name |
| `reconcile` | persisted handle/profile identity | running, terminal, not found, or unknown observation | never starts a replacement process |

Callers must know the work-approved intent, pinned context, execution directory,
authority, deadline, and event destination. They do not know executable flags,
parser states, provider session tokens, PID-tree mechanics, or provider-specific
error text.

## 5. Seam, dependencies, and Adapters

| Dependency | Category | Design consequence |
|---|---|---|
| prompt/context assembly | In-process; Collaboration/Orchestration is responsible | supplied as prepared input; Runtime does not rebuild it |
| local process spawning and OS process tree | Local-substitutable | internal process seam; test with controlled child processes |
| Coding Agent CLI protocol | True external | Runtime Interface is the seam; one Adapter per verified CLI |
| provider authentication/account | True external fact | discovery reports capability/authentication; Runtime does not maintain credentials |
| SQLite Session persistence | Local-substitutable | internal repository seam; not exposed through Runtime Interface |

Target Adapters:

| Adapter | Target status | Evidence rule |
|---|---|---|
| Codex | Production target | Current real spawn/resume/parser is a preservation candidate; target cancellation and reconciliation still require proof |
| Google Antigravity CLI | Production target | Missing until executable, protocol, Session, cancellation, and permission behaviour are verified |
| Claude Code | Reference only | Current Adapter is implementation evidence; no target subscription/default commitment |
| Gemini CLI | Reference only | Must not be relabeled as Antigravity |

A scripted test Adapter is justified because the true external CLIs cannot
reliably produce malformed streams, timing races, or unknown outcomes on
demand. Internal parser/process seams remain private to each Adapter.

## 6. Invariants and lifecycle

1. One `start` request activates at most one real CLI.
2. A Session has at most one live use generation.
3. Runtime observations carry stable Invocation and provider-event identity
   before Work Orchestration can accept them.
4. CLI completion means only runtime completion; it cannot mark a Run successful
   or a Thread accepted.
5. Missing, unauthenticated, or incapable Adapters never fall back to another
   CLI.
6. A resume requires a proven usable Session and provider continuity reference.
7. Unknown process/effect outcome blocks blind automatic respawn.
8. Runtime cancellation is scoped to the supplied handle and Invocation.

Session:

```text
new -> usable -> in_use -> usable
                   \-> sealed
                   \-> lost
```

Runtime observation:

```text
start_requested -> started -> running -> completed | failed | canceled | timed_out
reconcile ----------------------------> running | terminal | not_found | unknown
```

Work Orchestration maps these observations to Agent Invocation state. Retry is
a new Agent Invocation; the Runtime never decides to retry.

## 7. Inter-Module Interfaces

| Module | Interaction |
|---|---|
| Work Orchestration | supplies prepared start/cancel/reconcile requests; uniquely maintains Invocation lifecycle, retry, and terminal races |
| Collaboration | supplies an accepted context snapshot through Work Orchestration; receives only accepted visible contributions |
| Memory | has no direct Runtime Interface; any recalled excerpts arrive only inside the immutable Context Snapshot prepared by Collaboration |
| Project Access | supplies the confined execution directory and fencing generation |
| Evaluation | consumes artifact/evidence references after execution; runtime prose or exit zero has no verdict authority |
| Tracker Integration | has no Runtime Interface |

## 8. Current-to-target mapping

| Current area | Actual meaning | Decision |
|---|---|---|
| `providers/base.ts#AgentService.invoke` | production provider protocol seam [CODE-CONFIRMED] | Preserve behaviour and deepen into the Runtime Interface |
| Codex service/parser | real registered CLI Adapter [CODE-CONFIRMED] | Preserve implementation candidate |
| Claude/Gemini services | real current Adapters [CODE-CONFIRMED] | Reference only for target defaults |
| `invokeSingleAgent` | timeout, Session selection, retry and stream coordination [CODE-CONFIRMED] | Preserve behaviour; retry/lifecycle authority belongs to Work Orchestration |
| Session store and mutex | durable continuity plus in-process serialization [CODE-CONFIRMED] | Preserve behaviour; replace mutex authority with durable Session-use generation |
| Invocation registry/cancel maps | process-local handle and cancellation lookup [CODE-CONFIRMED] | Replace as authoritative recovery mechanism |
| Antigravity Adapter | absent [CODE-CONFIRMED] | Missing |

## 9. Verification

Tests use the Runtime Interface. They prove capability discovery, one-spawn
idempotency, event normalization/deduplication, malformed stream handling,
Session exclusion, timeout, process-tree cancellation, cancel/completion races,
and restart observations of running, terminal, not-found, and unknown.

Real smoke tests are required for Codex and Antigravity before either Adapter is
declared usable. Fake Runtime success proves only the scripted Interface
behaviour.

## 10. Open decisions

The Antigravity executable, protocol, Session semantics, cancellation, and
enforceable permission controls require direct verification. They must not be
inferred from Gemini.
