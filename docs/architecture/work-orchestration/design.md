# Work Orchestration Design

> Status: **Canonical target-module draft — under design review**
> Module: **Work Orchestration**
> Created: 2026-07-26
> Source hierarchy: [domain context](../../domain/CONTEXT.md) → this design → [system overview](../overview.md); audits and research are evidence, not competing rules.

## 1. Responsibility

Work Orchestration turns an accepted Chymia work intent into a durable,
inspectable and recoverable execution history. It is the unique source of truth
for every bounded **Run**, every single-CLI **Agent Invocation**, inbound
command idempotency, exclusive dispatch, retry/reconciliation, and the durable
record of external effects that can gate execution progress.

It does not maintain tracker facts, conversation text, CLI protocol details,
Local Project access, provider-side sandbox enforcement, or Result Contract
evaluation. Those Modules provide facts through explicit Interfaces. Work
Orchestration is authoritative for the user's Authorization Grants and alone
decides whether its Run, Invocation, grant, or effect records may transition.
Collaboration maintains the Thread's coding objective, conversation,
participants and explicit human acceptance.

This is a deep Module: callers use `submit` and `inspect`, while its Implementation hides ordering, transactions, compare-and-set transitions, duplicate delivery, queueing, retries, terminal races and restart reconciliation. That gives Web, Feishu, tracker ingress, callbacks and internal facts one Interface and one test surface.

### Why this is a Module

Deleting Work Orchestration would not remove lifecycle complexity. Command
idempotency, execution transitions, claims, retry budgets, terminal races,
effects, and restart recovery would reappear independently in Web, Feishu,
tracker ingress, Runtime callbacks, and schedulers. The two-operation Interface
concentrates that knowledge and gives every caller the same semantics.

## 2. State uniquely maintained by Work Orchestration

| State | Meaning | Authority / persistence | Recovery rule |
|---|---|---|---|
| Run | One bounded, pinned attempt to satisfy the coding objective recorded by a Thread | Work Orchestration; SQLite snapshot plus facts | Reconcile every non-terminal Run before new ingress or dispatch |
| Agent Invocation | One activation of exactly one Coding Agent CLI within a Run | Work Orchestration; SQLite snapshot plus normalized execution facts | Reconcile process/provider handle; unresolved outcome becomes `interrupted`, never fabricated success |
| Command Receipt | Idempotency identity, payload hash, accepted/rejected result | Work Orchestration; unique SQLite `(source, idempotency_key)` | Same payload returns original receipt; different payload under same key conflicts |
| Dispatch Queue | Eligible dispatch/retry work and its due time | Work Orchestration; durable SQLite rows | Expired queue lease becomes eligible only after reconciliation |
| Dispatch Claim | Time-bounded exclusive right to dispatch a Run | Work Orchestration; holder Invocation/process identity, expiry and fencing token in SQLite | Fence/release expired claim before re-dispatch |
| Retry Schedule | Classified retry budget, next attempt and terminal exhaustion fact | Work Orchestration; pinned Run policy and durable facts | Resume only within persisted deadline/budget; exhaustion creates a Human Decision Point |
| Authorization Grant | Immutable principal, allowed action classes, Local Project/effect scope, policy version and expiry recorded from an explicit user decision | Work Orchestration; durable SQLite fact | Expired or revoked grants fail closed; widening requires a new grant rather than mutation |
| External Effect Ledger | Normalized intent, idempotency identity, observed outcome and compensation relation for effects caused by a Run/Invocation | Work Orchestration; durable append/history plus current outcome | `outcome_unknown` blocks blind replay; a compensating action is a new effect |

The External Effect Ledger is the source of truth for **effect lifecycle facts**,
not filesystem path validation, sandbox enforcement, or project-access
acquisition. Work Orchestration validates the requested effect against its
recorded Authorization Grant before the effect can enter `authorized`; Project
Access and the executing Adapter enforce their respective path, fencing, and
provider controls. Grant and access identities are immutable references in the
ledger.

## 3. Core Invariants

1. Every state-changing ingress is a `WorkCommand`; no Connector, Tracker Adapter or CLI Adapter may spawn a process or mutate lifecycle state directly.
2. A command receipt, accepted aggregate transition, domain/audit fact and any resulting outbox intent commit in one local transaction.
3. One Thread has at most one non-terminal Run by default. Explicit isolated-experiment policy is required to vary this rule.
4. Terminal Runs and Invocations never reopen. A user retry creates a new Run; a process/provider retry creates a new Invocation.
5. An Invocation terminal fact never implies Run success. Only a satisfied Evaluation Verdict can permit `Run → succeeded`.
6. `Run succeeded` never implies `Thread satisfied`. Collaboration records the separate explicit human acceptance decision.
7. A Dispatch Claim prevents duplicate orchestration only; it is not an Authorization Grant or Project Access right.
8. Every effect receives a durable idempotency identity before execution. An unknown effect outcome is not automatically retried.
9. All state transitions use expected aggregate versions. The first accepted terminal transition is immutable; later observations are retained as late facts.
10. Current UI/socket projections, tracker status and conversation messages cannot replace the Module state defined here.

## 4. Interface and Seam

```ts
interface WorkOrchestrator {
  submit(command: WorkCommand): Promise<CommandReceipt>;
  inspect(query: WorkQuery): Promise<WorkView>;
}
```

`WorkCommand` is a closed union. It includes start, pause, resume, cancel,
terminate, retry, internal execution facts, evaluation verdicts,
tracker-triggered execution requests and authorized external-effect requests.
Thread creation, conversation changes and accept/revise/abandon decisions use
the Collaboration Interface instead. Each execution command carries a command
ID, source, idempotency key, payload hash, principal/provenance and, where
relevant, expected Run version.

### Caller contract

- **Must know:** the requested domain intent, principal/provenance and expected version if changing an observed aggregate.
- **Need not know:** SQL transaction order, store schemas, queue/claim mechanics, provider flags, retry timers, cancellation races or reconciliation steps.
- **Result:** an accepted, rejected, duplicate or conflict receipt with stable identifiers and aggregate versions. Accepted never later becomes unaccepted.
- **Errors:** validation, authorization denial, unavailable capability, capacity, version conflict, idempotency conflict and transient infrastructure failure are distinct outcomes.
- **Idempotency:** identical `(source, key, payload_hash)` returns the original receipt; a different hash with the same key is a conflict.
- **Capacity:** dispatch is bounded. A command may be accepted and durably queued; it must not cause an in-memory-only execution.

The Seam is at all work intent ingress because multiple real callers vary there. It is not a testing-only Seam: production Web, Feishu, tracker observation, callbacks and restart reconciliation all need the same semantics. Production uses SQLite and real collaborating Modules; a deterministic fault-injecting Implementation is a test Adapter behind the same Interface.

Construction is asynchronous: readiness fences stale workers and reconciles non-terminal state before the Interface accepts new commands. Reconciliation is deliberately an Implementation obligation, not a third public method.

### Dependency classification

| Dependency | Category | Design consequence |
|---|---|---|
| lifecycle and policy computation | In-process | keep inside the Implementation |
| SQLite transactions and durable queue | Local-substitutable | test through the Module Interface with temporary SQLite |
| clock, scheduler and worker wake-up | Local-substitutable | inject internally for deterministic tests; do not expose on the Interface |
| other Chymia Modules | In-process | call their Interfaces; never reach through to their stores or Adapters |
| Coding Agent CLIs and trackers | True external; other Modules control their protocol interaction | Work Orchestration never calls their protocol Adapters directly |

## 5. Lifecycle

### 5.1 Thread relationship

A Run cannot exist without an open Thread reference. Work Orchestration reads
the pinned Thread objective, Local Project, Result Contract and context
references needed by the Run, but cannot change the Thread conversation or
acceptance. A revision decision on the same Thread may request a later Run.
A genuinely new coding objective creates a new Thread.

### 5.2 Run and Invocation

A Run begins `queued`, then may move through `preparing`, `running`, `awaiting_permission`, `awaiting_human`, `pause_requested`, `paused`, `retry_wait` or `cancellation_requested`. Terminal states are `succeeded`, `failed`, `timed_out`, `canceled`, `interrupted` and `terminated`.

- Dispatch acquires a durable Dispatch Claim, then obtains the required environment grant/lease through its Interface. The Run is persisted before any CLI starts.
- `running → awaiting_permission` occurs before an ungranted effect. A denied permission produces an explicit failure, cancellation or Human Decision Point; it never silently widens authority.
- A pause is valid only at a durable safe point. If a CLI cannot checkpoint, the requested pause is represented as cancellation and a later new Run, not untracked process suspension.
- Automatic retry is finite and persists classification, backoff, attempt count and deadline. Every re-spawn is a new Invocation. A user retry after a terminal Run is a new Run.
- Cancellation persists intent before signalling. Completion/cancellation/timeout/crash races resolve by expected version; late facts remain observable but cannot reverse a terminal state.

An Invocation begins `queued`, may wait for project access or permission, then enters `starting` and `running`; it terminates as `succeeded`, `failed`, `canceled`, `timed_out`, `interrupted` or `skipped`. It exists durably before Coding Agent Runtime starts. A missing process during reconciliation is `interrupted` unless a durable terminal receipt proves another outcome.

### 5.3 Effects and acceptance handoff

Effect states are `proposed → authorized → executing → succeeded | failed | outcome_unknown`; `compensated` records a distinct compensating effect, never deletion of history. A successful effect receipt does not change Thread Acceptance by itself.

The completion chain is strictly:

```text
Invocation terminal facts
  → Evaluation Verdict
  → Run succeeded
  → Collaboration records Thread awaiting_acceptance
  → user accepts | revises | abandons the Thread
  → optional tracker write-back intent
```

## 6. Failure and Recovery

| Condition | Durable expression | Recovery |
|---|---|---|
| command redelivery | duplicate receipt | return original result, do not repeat dispatch |
| stale command | version conflict | caller re-reads via `inspect` and submits explicit new intent |
| provider unavailable before start | queued/failed Run or skipped Invocation | rediscover capability or choose another allowed profile; no fake substitution |
| known CLI failure | failed Invocation | classified finite retry or terminal failed Run |
| lost process / host crash | interrupted Invocation/Run | reconcile facts and handles; never infer success |
| stale Dispatch Claim | fenced claim | claim holder cannot mutate; reconcile then release/reclaim |
| permission denied | awaiting permission / blocked / failed | wait for explicit decision or terminate according to command |
| effect outcome unprovable | `outcome_unknown` | reconcile using external idempotency/receipt or require human decision |
| successful evaluation but crash before Run transition | persisted Verdict without transition | deterministic startup consumption, no CLI rerun |
| tracker write-back fails | local Thread Acceptance unchanged; outbox/effect failure | retry delivery idempotently or surface unknown outcome |

## 7. Inter-Module Interfaces

| Collaborating Module | Work Orchestration consumes | Work Orchestration provides | State-authority rule |
|---|---|---|---|
| Tracker Integration | proposed tracker-derived command, binding/revision health, pre-dispatch refresh fact | work query/command receipt and durable write-back request | tracker is authoritative for Issue facts; Work Orchestration is authoritative for the local lifecycle |
| Collaboration | open Thread, Worklist facts, context references and explicit revision request | Run/Invocation facts and successful Verdict reference | Collaboration changes Thread and acceptance; Work Orchestration changes Run and Invocation |
| Memory | Capture Receipts and visible recall/extraction degradation | terminal Run/Invocation and Evaluation source references through idempotent capture requests | Memory cannot transition work state; recalled text cannot authorize execution or satisfy Evaluation |
| Coding Agent Runtime | normalized start/event/terminal/reconcile observations and provider-side enforcement capability | prepared Invocation and cancel/reconcile request | Runtime never declares Run success and must refuse unenforceable provider controls |
| Project Access | Local Project identity, confined execution directory, access/fencing and reconciliation facts | project-access request carrying Run/Invocation, baseline and grant references | is authoritative for project access, not permission grants or effect lifecycle |
| Evaluation | versioned Verdict | pinned Result Contract/Run/artifact references | Evaluation returns a verdict; Work Orchestration changes Run state but cannot accept the Thread |
| Delivery / Tracker Writer | delivery receipt for an existing outbox item | durable authorized write-back intent | delivery cannot alter local acceptance |

Cross-Module end-to-end flows are not repeated here as a separate scenario contract. Each Module defines its input/output rules; callers compose them only through these Interfaces.

## 8. Current-to-Target Mapping

| Current area | Actual evidence | Decision | Target use |
|---|---|---|---|
| `packages/api/src/socket/handler.ts#handleThreadMessage` | production ingress directly routes Thread messages to agents | Preserve behaviour, replace lifecycle authority | translate inbound intent into `WorkCommand` |
| `packages/api/src/routing/agent-router.ts#AgentRouter` | production serial/parallel route control, but worklists are process-local | Preserve behaviour | Collaboration supplies bounded worklist facts; Work Orchestration is authoritative for Run lifecycle |
| `packages/api/src/invocations/invocation-registry.ts#InvocationRegistry` | in-memory `Map`, no durable lifecycle | Replace | durable Command Receipt/Invocation/claim authority |
| current cancellation maps | in-memory AbortControllers | Replace | persisted cancellation intent and reconciliation |
| SQLite Thread/Message/Session/Tool stores | real persisted collaboration history | Preserve behaviour/data | Collaboration retains Thread/message facts; Run state remains separate |
| Task/TaskProgress tables | no closed production execution authority; fake-backed paths | Reference only | do not rename into Thread or Run |
| existing retry classifier | real error classification behaviour | Preserve behaviour where it matches | bounded persisted retry policy |
| best-effort audit writes | observability exists but is decoupled from lifecycle | Replace | atomic lifecycle/effect facts |
| durable Run/Invocation/Claim/Receipt/Effect records | absent | Missing | this Module's authoritative state |

## 9. Verification

Verification crosses the Module Interface and real persistence; fake-only tests do not prove external effects or recovery.

1. Repeated tracker or connector delivery with the same idempotency key yields one receipt and at most one active Run for the referenced Thread.
2. Two concurrent `StartRun` commands yield one Dispatch Claim/Run and one typed conflict or duplicate.
3. A zero-exit CLI makes only the Invocation terminal; Run success requires a persisted satisfied Verdict.
4. A satisfied Verdict produces a durable `Run succeeded` fact; Collaboration separately records `Thread awaiting_acceptance`, and neither tracker status nor agent text can substitute.
5. User revision preserves the succeeded Run and starts a later new Run; user acceptance persists before any write-back attempt.
6. Process termination after each commit point—receipt, claim, Run/Invocation creation, process spawn, effect start, Verdict, acceptance and remote delivery—recovers without a duplicate process/effect or fabricated success.
7. An `outcome_unknown` effect blocks automatic replay and remains visible through `inspect`.
8. A late event carrying an obsolete aggregate version/fencing identity is retained for audit but cannot mutate the current lifecycle.

## 10. Accepted Thread and Issue Authority Rule

Work Orchestration applies the accepted rule that Chymia maintains Threads and
execution facts while trackers maintain Issues. A tracker-derived command may
create or bind a Thread, but the Issue cannot replace the local Thread or
determine Run completion. The canonical decision is recorded in
[Tracker Integration](../tracker-integration/design.md#10-accepted-thread-and-issue-authority-decision).

## 11. Open Decisions

1. Whether an explicit isolated-experiment policy may allow more than one non-terminal Run for a Thread; default remains one.
2. The repository-specific finite values for attempt count, deadline, Invocation timeout/token budget and backoff. They must be configured and pinned, never silently unbounded.
3. Whether a future fully mechanical Result Contract may trigger automatic acceptance. The current target default remains explicit Personal Developer acceptance.
