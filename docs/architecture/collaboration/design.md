# Collaboration Module Design

> Status: **Canonical target-module draft — under design review**; it is not a claim about the current implementation.
> Created: 2026-07-26
> Scope: Thread coding objective, conversation facts, participants, bounded Worklist, context assembly, human acceptance, and human-readable projections.
> Canonical terms: [CONTEXT.md](../../domain/CONTEXT.md).
> Evidence sources: [target snapshot](../../history/design-snapshots/2026-07-13-target-design-baseline-1.md), [slice snapshot](../../history/design-snapshots/2026-07-13-symphony-vertical-slice.md), and [current execution-path audit](../../audits/current-system/2026-07-22-thread-to-cli.md).

## 1. Responsibility and exclusions

The Collaboration Module is the source of truth for a Thread: the persistent
top-level record for one coding objective. It records the objective, Local
Project reference, participants, what was said or observed, what ordered
collaboration contribution is next, and whether the user accepted, revised or
abandoned the result. It gives callers a small Interface for Thread creation,
append, read, context assembly, Worklist semantics and acceptance.

It does **not** decide whether a Run or Invocation succeeded, failed, canceled
or may retry. Those are Work Orchestration decisions. It may record Thread
Acceptance only after referencing the applicable Run and Evaluation Verdict.
A CLI process is not Collaboration state; Coding Agent Runtime reports process
facts and Work Orchestration decides how they affect execution.

### Why this is a Module

Deleting Collaboration would spread conversation ordering, participant
membership, Worklist progress, context selection, replay, and projection
rebuilding across ingress, orchestration, UI, and CLI preparation. Its small
append/read/context Interface hides that complexity and provides Leverage to
all of those callers. Socket delivery and UI rendering remain Implementation
details or downstream projections, not alternate Interfaces.

This separation prevents the current Thread-driven request handler from becoming a competing execution state machine. [CODE-CONFIRMED] The production path currently starts from a Thread message and routes directly to a CLI; router worklists and cancellation state are in memory. `packages/api/src/routes/message-handler.ts#handleThreadMessage`, `packages/api/src/routing/route-serial.ts`, and `packages/api/src/infrastructure/socket-manager.ts`.

## 2. State uniquely maintained by Collaboration

| State | Meaning | Unique source of truth | Persistence / recovery |
|---|---|---|---|
| Thread | Persistent top-level record for exactly one coding objective, its Local Project reference, collaboration and result disposition | Collaboration | Canonical SQLite record; archive rather than discard when referenced execution history exists |
| Participant membership | The stable membership and collaboration role/reference of an agent or human in a Thread. A participant references an Agent Profile; it does not maintain profile configuration. | Collaboration | Immutable join/leave facts or versioned membership record. |
| Conversation fact | An immutable user message, agent contribution, handoff, declared context reference, or other collaboration-visible fact. | Collaboration | Canonical ordered fact log, deduplicated by fact identity. |
| Thread cursor | Per-Thread `epoch` and monotonically increasing `sequence` used for append order, reconnect, and catch-up. | Collaboration | Durable; a reconnect never infers order from Socket.IO arrival. |
| Worklist | The bounded ordered collaboration plan for one Run: roles, Agent Profile references, predecessor and join requirements. | Collaboration | Durable entries keyed by `(run_id, ordinal)`; the Run ID refers to state maintained by Work Orchestration. |
| Worklist contribution position | Derived/recorded readiness of a Worklist entry: `waiting`, `eligible`, `contributed`, `blocked`, or `skipped`. It describes collaboration progress only. | Collaboration | Rebuilt from plan plus accepted contribution facts when necessary. |
| Thread Acceptance | Explicit `awaiting_acceptance`, `satisfied`, revision, or `abandoned` decision tied to a Run and Verdict where applicable | Collaboration | Durable Thread facts; later tracker delivery failure cannot reverse the local decision |

`Thread`, `Run`, `Session`, and `Agent Invocation` are deliberately different
objects. One Thread represents one coding objective and persists across its
Runs; a Run is one attempt; a Session is provider continuity; an Invocation is
one CLI activation. Branching, serial handoff and parallel collaboration remain
inside the same Thread. [USER-DECISION] [CONTEXT.md](../../domain/CONTEXT.md).

The human-readable Thread view is a derived output rebuilt from conversation
facts. It is not a second authoritative state alongside those facts.

## 3. Core invariants

1. One Thread represents exactly one coding objective. A materially new
   objective requires a new Thread; branching or revision of the same objective
   does not.
2. A Conversation fact has a stable identity and is immutable once accepted. A correction, redaction marker, or new answer is a new fact; it does not rewrite history.
3. Each accepted fact occupies exactly one `(thread_id, epoch, sequence)`. Repeating the same fact identity is a no-op; a caller attempting to append at a gap receives a catch-up requirement rather than an invented order.
4. Participant membership records collaboration identity and role only. It never implies that a provider is installed, authorized, or capable of executing.
5. A Worklist is finite, pinned to one Run, and has no recursive fan-out. It may request that the Orchestrator create an Invocation only when its predecessor/join rule makes an entry eligible; it cannot create one itself.
6. A Worklist contribution is not a Run outcome. A Reviewer contribution is
   Evidence for Evaluation, not Thread Acceptance or Run success.
7. A context snapshot is deterministic for its Thread cursor, Worklist
   position, requesting role/profile, declared limits, referenced facts and
   recorded Memory/index revisions. The Module never silently reads an entire
   transcript, another Local Project's Memory or another agent's private
   provider Session.
8. Thread views, Socket.IO delivery, and UI state are rebuildable observers. They cannot mutate Thread, Worklist, Run, Invocation, or Session truth.

## 4. Interface

The Module is an in-process Module, so its Interface is typed rather than a network protocol. Its public surface is intentionally about collaboration facts, not store rows or execution transitions.

```ts
interface Collaboration {
  ensureThread(spec: ThreadSpec): Promise<ThreadRef>;
  append(input: ConversationFactInput, expected: ThreadCursor): Promise<AppendReceipt>;
  read(query: ConversationQuery): Promise<ConversationPage>;
  assembleContext(request: ContextRequest): Promise<ContextSnapshot>;
  defineWorklist(spec: WorklistSpec): Promise<WorklistReceipt>;
  recordWorklistContribution(input: WorklistContribution): Promise<WorklistReceipt>;
  decideAcceptance(input: ThreadDecision): Promise<ThreadReceipt>;
}
```

| Operation | Caller supplies | Result and error semantics | Hidden Implementation complexity |
|---|---|---|---|
| `ensureThread` | Coding objective, Local Project reference, initial human identity and collaboration specification | Existing Thread for the same creation identity or newly created Thread; conflicting payload under the same identity is rejected | creation idempotency, initial cursor, objective and membership facts |
| `append` | Stable fact ID, fact kind/payload, actor/provenance, Thread cursor | accepted cursor, duplicate receipt, or `catch_up_required` / version conflict | atomic sequence allocation, identity deduplication, validation, projection notification |
| `read` | Thread, cursor/range, visibility rule and page limit | ordered facts plus next cursor; missing cursor is a typed gap, not empty history | archival storage, pagination, visibility filtering |
| `assembleContext` | Thread cursor, Worklist entry/role, current Local Project identity, Memory scope policy, budget and allowed reference kinds | immutable bounded Context Snapshot with source cursors, Memory/source revisions and degraded status | compaction, deterministic selection, scoped Memory recall, omission explanation, reference lookup |
| `defineWorklist` | Run reference, bounded entries, predecessor/join rules and pinned collaboration specification | immutable plan receipt or invalid/over-budget plan | ordinal checks, membership/profile references, duplicate plan protection |
| `recordWorklistContribution` | accepted contribution fact reference, entry, expected plan version | updated readiness/progress receipt; a late contribution is retained but does not reopen execution | predecessor/join calculation, duplicate and late-fact handling |
| `decideAcceptance` | Thread, `accept`/`revise`/`abandon`, applicable Run/Verdict reference, expected Thread version and user provenance | durable decision receipt or typed invalid-state/version conflict | validates current successful Run for acceptance, preserves prior attempts, emits optional tracker write-back intent |

### Idempotency, order, capacity, and permissions

- `append` deduplicates by fact identity. `defineWorklist` deduplicates by `(run_id, collaboration_spec_version)`; a different payload under the same identity is a conflict.
- The only ordering contract is the durable Thread cursor. A caller must catch up before retrying a gap; websocket delivery order is not a substitute.
- Context assembly must enforce a declared message/token/reference budget. It returns a bounded snapshot plus omission metadata, never unbounded hidden context.
- Context assembly calls the [Memory Interface](../memory/design.md#7-interface)
  with Personal plus exactly the current Local Project scope. It records the
  returned identities, revisions and degraded status; it never queries Memory
  storage or QMD directly.
- Collaboration accepts only identities and facts already authorized by the
  Module responsible for the caller. It validates provenance and visibility
  but does not decide Local Project access or CLI grants.
- Production uses SQLite and durable projections. Test Implementations may be deterministic/fault-injecting, but tests use this Interface rather than message-table internals.

The Seam is here because collaboration ordering, replay, selection, and compaction are substantial shared complexity. Hiding them gives Work Orchestration, connectors, and Coding Agent Runtime leverage without leaking storage or UI mechanics.

### Dependency classification

| Dependency | Category | Design consequence |
|---|---|---|
| ordering, Worklist readiness and context selection | In-process | keep inside the Implementation |
| SQLite conversation facts | Local-substitutable | test through Collaboration with temporary SQLite |
| token counting/context budgets | Local-substitutable | internal strategy; do not expose a separate public seam |
| Socket/UI projection delivery | In-process downstream observer | projections consume durable facts and never become a source of truth |
| Coding Agent CLI | True external; Coding Agent Runtime controls invocation | Collaboration never calls a CLI Adapter |

## 5. Lifecycle and collaboration semantics

### 5.1 Thread and conversation lifecycle

```text
open -> active -> awaiting_acceptance -> satisfied
          ^              |
          |--- revise ---|
open/active/awaiting_acceptance -> abandoned
```

- `open`: `ensureThread` has recorded the coding objective, Local Project and
  initial membership; no Run is required yet.
- `active`: collaboration or a Run is progressing. Failed or canceled Runs may
  leave the Thread active for another attempt.
- `awaiting_acceptance`: a referenced Run has succeeded through Evaluation and
  the user must accept, revise or abandon.
- `satisfied`: the user explicitly accepted the result. It is terminal.
- `abandoned`: the user explicitly ended the objective without acceptance. It
  is terminal.
- `revise` returns the same Thread to `active`; a later attempt is a new Run,
  not a new Thread.

Archival is an orthogonal retention action, not a Run cancellation or
acceptance state. Hard deletion is prohibited while any referenced Run,
Invocation, Session, lease, effect, or retained artifact exists. [INFERENCE]
This removes the current partial-cascade hazard where Thread deletion can leave
Session and audit rows orphaned. [CODE-CONFIRMED]
`packages/api/src/stores/sqlite-thread-store.ts#delete`.

### 5.2 Worklist lifecycle

```text
declared -> waiting -> eligible -> contributed
                   -> blocked
                   -> skipped
```

- `declared` is the immutable Run-pinned plan.
- `waiting` has unmet predecessor or join requirements.
- `eligible` means the collaboration plan permits the Orchestrator to request the next Invocation; it is not a process-started state.
- `contributed` means an accepted contribution fact has been associated with the entry. It does not mean the associated Run succeeded.
- `blocked` and `skipped` retain their reason and source fact. Neither emits a hidden retry or substitutes another agent.

Serial handoff uses the predecessor's accepted contribution and a bounded context snapshot. Parallel fan-out gives siblings the same pinned starting snapshot; they do not observe each other's live output. A parallel branch cannot add more branches. [INFERENCE] [target snapshot](../../history/design-snapshots/2026-07-13-target-design-baseline-1.md#15-main-runtime-or-workflow-semantics).

### 5.3 The first issue-driven slice

For the next slice, the Worklist is deliberately minimal:

```text
Implementer (mutating) -> Reviewer (read-only) -> Evaluation
```

The Reviewer may create a conversation contribution and Evidence reference. Evaluation is not a Worklist participant and Worklist exhaustion does not itself mark the Run successful. [INFERENCE] [slice snapshot](../../history/design-snapshots/2026-07-13-symphony-vertical-slice.md#9-deterministic-workspace-and-multi-agent-rules).

## 6. Inter-module Interfaces

| Counterpart | Collaboration receives | Collaboration returns | State-authority rule |
|---|---|---|---|
| Work Orchestration | Run-pinned Worklist specification and accepted Invocation/contribution facts | open Thread reference, coding objective, readiness/contribution receipts, bounded context and acceptance decision | Collaboration changes Thread and acceptance; Work Orchestration changes Run and Invocation |
| Memory | bounded query, Personal/current-Project scope, source-kind and result budget | recalled excerpts with source/Memory/index revisions and degraded status | Memory maintains admitted knowledge; Collaboration alone decides which returned excerpts enter its immutable Context Snapshot. |
| Coding Agent Runtime | no direct lifecycle write | Context Snapshot through Work Orchestration; agent-visible contribution facts only after acceptance | Runtime normalizes CLI/process facts; it cannot append authoritative collaboration facts around Work Orchestration. |
| Evaluation | Artifact/Evidence references may be represented in context when visibility allows | reviewer/handoff contribution references | Evaluation is authoritative for verdict/Evidence semantics; Collaboration does not interpret a verdict. |
| Connector / Projection delivery | normalized inbound user or platform message with provenance | read model/projection events after durable append | Web, Feishu, Socket.IO, and UI are protocol/delivery adapters; none may change the Thread cursor directly. |
| Agent configuration | participant/profile references | no provider configuration | A participant is not a provider capability claim. |

## 7. Failure, recovery, and degraded behavior

| Situation | Collaboration result | Recovery |
|---|---|---|
| Duplicate inbound/platform delivery | duplicate receipt; no second fact | Return original cursor/receipt. |
| Expected cursor gap or stale client | `catch_up_required` | Read from durable cursor, then append against the current cursor. |
| Socket/UI disconnect | no source-state change | Rebuild projection or catch up by epoch/sequence. |
| Agent process disappears | no inferred conversation success/failure | Work Orchestration reconciles Invocation; Collaboration retains prior facts. |
| Late contribution after Run terminal | retain as late fact with correlation | It cannot reopen the Run or alter acceptance. |
| Context budget exhausted | bounded snapshot with omissions/references | Caller can request an explicitly different budget/policy; no silent full-history expansion. |
| Memory recall stale or unavailable | bounded snapshot records `stale`, `lexical_fallback` or `memory_unavailable`; no silent empty-success claim | Continue according to Work Orchestration policy and retry/rebuild Memory independently. |
| Satisfied or abandoned Thread requested for a new objective | typed terminal result | Create a new Thread; history remains readable |

## 8. Current-to-target mapping

| Current area | Evidence of actual use | Target decision | Rationale |
|---|---|---|---|
| `SqliteThreadStore`, `SqliteMessageStore` | Production ingress writes Thread/user message; replies persist after stream. `message-handler.ts#handleThreadMessage` | Preserve behaviour | Durable collaboration history is valuable, but deletion responsibility and lifecycle semantics must change. |
| `AgentRouter`, `route-serial.ts`, `route-parallel.ts` | Production route selection and serial/parallel paths. `agent-router.ts#route` | Preserve behaviour | Participant selection, serial handoff, and snapshot parallelism are useful; a durable Worklist maintained by Collaboration replaces in-memory control flow. |
| `context/hierarchical-context.ts` and system-prompt assembly | Production builds bounded message/evidence/task context | Preserve behaviour | Context selection belongs behind `assembleContext`; current prompt assembly must not determine Run lifecycle. |
| Socket thread sequencing and `SocketManager` projection | Production broadcasts `agent_event` / `agent_status`; ordering is process-memory promise sequencing | Replace Implementation | Preserve ordered delivery behavior with durable epoch/sequence and catch-up; Socket.IO remains a projection. |
| `routing/state-machine.ts#MultiMentionStateMachine` | No confirmed production composition | Reference only | It may inform bounded Worklist rules but is not current authoritative state. |
| `Task` / `task_progress` records | Current Task snapshots enter prompts; they are not Run state | Reference only | They may become a collaboration context reference only after a separate domain decision; they must not become Worklist or Run truth. |

## 9. Verification and acceptance evidence

The Module is acceptable only when its Interface proves all of the following:

1. Create/reuse one Thread for one coding objective and reject a conflicting payload under the same creation identity.
2. Append user, agent, and handoff facts with duplicate delivery, stale cursor, and reconnect/catch-up cases.
3. Produce the same bounded Context Snapshot for the same cursor, role, and budget; expose omitted references rather than leaking hidden full history.
4. Pin exact Memory/source/index revisions in the Context Snapshot, prevent
   Project A recall in Project B, and distinguish a true empty result from
   degraded/unavailable Memory.
5. Run the bounded Implementer -> Reviewer Worklist: reviewer receives only allowed predecessor/context facts; its contribution cannot mark a Run complete or accept the Thread.
6. Demonstrate that socket outage/restart rebuilds the human-readable Thread view from durable facts without changing execution state.
7. Demonstrate that a late or duplicate provider contribution cannot reopen a terminal Run.

## 10. Open decisions

- The retention duration and whether a legally safe hard-delete policy is ever needed remain open. The target rule is archive-first.
- The exact visibility and selection policy for Evidence and any retained legacy Task records in a Context Snapshot remains open; it must be versioned and budgeted.
- Parallel read-only fan-out is part of the broader target but is outside the first slice. Its join rule must be specified before it is enabled.
- No separate user product decision is required for this Module contract; it
  follows the confirmed Thread-centered model and Codex/Antigravity scope.
