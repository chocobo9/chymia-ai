# Evaluation Design

> Status: **Canonical target-module draft — under design review**
> Created: 2026-07-26
> Scope: Result Contract versions and clauses, Result Artifact/Evidence verification, and versioned Evaluation Verdicts.
> Canonical vocabulary: [CONTEXT.md](../../domain/CONTEXT.md) (`Result Artifact`, `Result Contract`, `Evidence`, `Evaluation Verdict`, `Thread Acceptance`).
> Source basis: [target snapshot](../../history/design-snapshots/2026-07-13-target-design-baseline-1.md), [slice snapshot](../../history/design-snapshots/2026-07-13-symphony-vertical-slice.md), and [current execution-path audit](../../audits/current-system/2026-07-22-thread-to-cli.md).

## 1. Responsibility and exclusions

This Module decides whether a pinned Run result mechanically satisfies a pinned Result Contract. It does not decide whether the Personal Developer accepts that result as satisfying the Thread's coding objective. [INFERENCE]

Evaluation is authoritative for Result Contract **clauses and versions**. Work
Orchestration is authoritative for the Run and stores only the
contract-version reference pinned at Run start. This resolves the older
target-design ambiguity that split Result Contract persistence from its
meaning. Evaluation defines the contract and verification semantics; Work
Orchestration decides which version a Run pins and how it consumes a verdict.
[INFERENCE]

The Module also does not maintain Authorization Grants, External Effects,
Project Access generations, Sessions, Agent Invocation state, tracker
write-back, or Thread Acceptance. It accepts immutable references to those
facts when they are relevant to evaluation.

### Why this is a Module

Deleting Evaluation would spread Result Contract versioning, clause semantics,
artifact provenance, gate normalization, and verdict generation across Work
Orchestration and repository-specific callers. Its Interface provides Leverage
by returning one clause-level Verdict while hiding tool output, evidence
collection, and contract-version rules.

## State uniquely maintained by Evaluation

| State | Meaning | Unique source of truth | Persistence | Rule |
|---|---|---|---|---|
| Result Contract Version | Immutable, validated clause set describing required results for a Run or Thread objective | Evaluation | SQLite/config snapshot | An edit creates a new version; an existing version is never changed. |
| Contract Clause | One named, typed requirement in a Result Contract Version | Evaluation | Stored with contract version | Clause semantics are versioned with the contract. |
| Result Artifact | Content-addressed/reference-stable concrete output attributed to a Run or Invocation | Evaluation | SQLite registry plus underlying Project Access/object reference | Its identity includes canonical reference, hash where applicable, producer, and time. |
| Evaluation Evidence | Immutable provenance-backed observation used to determine one clause | Evaluation | SQLite/artifact reference | Agent prose alone is not verified evidence. |
| Evaluation Verdict | Versioned terminal result for one evaluation generation: `satisfied`, `unsatisfied`, or `indeterminate` | Evaluation | SQLite | It includes per-clause results and evidence references. |

`Thread Acceptance` remains separate: the Personal Developer decides it
through an explicit accept, revise, or abandon command, and Collaboration
persists it. A satisfied verdict makes Run success permissible; it cannot write
`Run succeeded`, change Thread Acceptance, or change tracker state.

## Responsibilities and non-responsibilities

### Responsibilities

1. Validate, publish, version, and retrieve Result Contract clause sets as one atomic publication operation.
2. Register Result Artifacts with stable references and hashes/provenance when available.
3. Collect and verify Evidence for repository gates, scoped diffs, reports, and other declared clauses.
4. Execute/coordinate deterministic validation through a repository-gate Adapter and normalize its output into Evidence.
5. Return an immutable, clause-level Evaluation Verdict for a pinned Run/contract version.
6. Preserve an `indeterminate` outcome when required inputs, environment, or effect reconciliation cannot be proven.

### Non-responsibilities

- creating/retrying/canceling Runs or Invocations;
- treating CLI exit zero, agent self-report, reviewer prose, HTTP 200, or tracker state as sufficient completion by itself;
- accepting, revising or abandoning a Thread;
- authorizing commands, Git changes, publication, or tracker write-back;
- maintaining Local Project access or mutating it while evaluating;
- operating the existing evidence-recall feature as an execution completion authority.

## Result Contract model

A Contract describes required outcomes, not implementation steps. Each version contains a typed clause list, evaluation policy/version, and its compatibility requirements.

The minimum coding-work Contract from the vertical slice is:

| Clause | Required verified evidence | Notes |
|---|---|---|
| `scoped_diff` | Canonical diff/reference and hash from the pinned Project Access generation/baseline; changed paths satisfy declared scope | A report-only Thread declares a required report Artifact instead. |
| `repository_gates` | Each configured gate's command, environment fingerprint, exit status, output digest, and Project Access/baseline reference | Text such as “tests passed” is not evidence. |
| `known_effect_outcomes` | Reference to the relevant External Effect Ledger generation showing no unresolved required effect | Evaluation reads this fact; it does not maintain or alter the ledger. |
| `required_report` | Required human-readable Artifact/reference when the Contract declares one | Commit, push, PR, or tracker closure are optional clauses only when explicitly configured and authorized. |

Reviewer output may register useful Evidence for human acceptance or an explicitly declared clause. It does not replace a required mechanical clause and cannot itself accept a Thread. [INFERENCE]

## Interface

```ts
interface Evaluation {
  publishContract(input: PublishResultContract): Promise<ResultContractVersion>;
  registerArtifact(input: RegisterResultArtifact): Promise<ResultArtifact>;
  evaluate(input: EvaluateRun): Promise<EvaluationVerdict>;
  inspectVerdict(input: InspectVerdict): Promise<EvaluationVerdict | null>;
}
```

### Interface semantics

| Operation | Inputs / output | Invariants and errors | Idempotency |
|---|---|---|---|
| `publishContract` | proposed clauses, repository/work type, evaluator rule version and author/provenance → immutable contract version | Validates before commit; rejects duplicate clause IDs, ambiguous completion rules, unbounded gates, and unavailable required capabilities. Existing versions cannot be edited. | Content/publisher idempotency returns the existing version. |
| `registerArtifact` | Run/Invocation attribution, canonical reference, kind, hash/provenance → artifact | Rejects unresolvable/out-of-scope references and identity conflicts. It does not infer artifact identity from chat text. | Same canonical artifact identity returns the existing artifact. |
| `evaluate` | Run ID, pinned contract version, Project Access read handle, artifact references, applicable effect-ledger version and evaluation generation → Verdict | Requires pinned/consistent inputs. Missing, unverifiable, or unsafe-to-run gate input produces `indeterminate`, never success. | One evaluation generation has one immutable verdict; a repeat returns it. Re-evaluation creates an explicitly linked new generation. |
| `inspectVerdict` | verdict ID or Run/generation → verdict | Read only. | Pure lookup. |

The caller sees typed clauses, artifact/evidence references, and a terminal verdict. It does not see parser internals, SOP loading, command-output normalization, hash computation, gate execution layout, or storage tables. This gives the Interface Depth and makes clause-level verification the primary test surface. [INFERENCE]

### Repository-gate Adapter

Repository gates are Local-substitutable dependencies behind Evaluation, not a second Module Interface. The production Implementation executes configured gates against the prepared Project Access handle; tests use controlled command runners or temporary repositories through an internal seam. Gate execution returns observations, not Verdicts.

Evaluation requires Project Access for confined read access and requires a
separately issued authorization/effect reference for commands that execute a
gate. It cannot widen read access or mint an Authorization Grant. This keeps
gate execution observable without making Evaluation a competing source of
truth for project access or permission lifecycle.

## Core invariants

1. Every Run points to one pinned immutable Result Contract Version before its first Invocation begins.
2. Contract edits produce a new version; they never alter the version a historical Run used.
3. Every Artifact/Evidence item has immutable provenance sufficient to identify its Run/Invocation, Local Project/access reference, collection time, and content/output digest where applicable.
4. `satisfied` means every required clause passed under the pinned contract/policy and all required inputs are known.
5. `unsatisfied` means at least one required clause was deterministically evaluated and failed.
6. `indeterminate` means completion cannot be proven because required data, environment, artifact identity, or effect outcome is unavailable/unknown. It is never coerced to `satisfied`.
7. CLI exit zero, agent “done”, reviewer approval, tracker `done`, and UI presentation are not Evaluation Evidence by themselves.
8. Evaluation Verdicts are terminal and immutable. A changed Contract, Artifact, project baseline, or evaluator version creates a new evaluation generation.
9. Evaluation never mutates Run, Thread, Thread Acceptance, Issue, Authorization Grant, or External Effect state.
10. A satisfied verdict may be consumed once idempotently by Work Orchestration; it does not directly transition any other aggregate.

## Lifecycle, errors, and recovery

### Contract Version lifecycle

```text
draft → validated → published → superseded
```

- `draft → validated`: schema and capability validation passes.
- `validated → published`: immutable version and evaluator policy version are persisted.
- `published → superseded`: a newer version becomes recommended for future Runs. A superseded version remains readable and valid for Runs that pinned it.

### Evaluation lifecycle

```text
requested → collecting → verifying → satisfied
                                  ↘ unsatisfied
                                  ↘ indeterminate
```

- A request requires an existing Run, pinned contract, Project Access read handle, and declared Artifact/effect references.
- `collecting` registers only provenance-backed observations; missing artifacts remain missing facts, not fabricated records.
- `verifying` evaluates each clause and records normalized gate output/Evidence.
- A terminal Verdict persists before Work Orchestration reads it. The Module never retries by mutating a terminal verdict; a new evaluation generation is explicitly requested.

### Error and recovery rules

| Condition | Verdict / recovery |
|---|---|
| Required Artifact absent or hash differs | `unsatisfied` if absence/mismatch is known. |
| Gate exits non-zero with recorded output | `unsatisfied` for that clause. |
| Gate cannot start, toolchain/environment cannot be proven, or Project Access read handle is unavailable | `indeterminate`; surface typed cause, do not report pass. |
| External Effect has `outcome_unknown` where Contract requires known outcomes | `indeterminate`; await reconciliation by the Module responsible for effects or a human decision. |
| Process dies after Evidence persistence but before Verdict persistence | On restart, reuse immutable Evidence and resume the same evaluation generation; do not rerun a non-idempotent gate blindly. |
| Process dies after Verdict persistence but before Run lifecycle consumption | Work Orchestration reads the existing Verdict and consumes it idempotently; there is one Run-success transition at most. |
| Late/duplicate gate output | Deduplicate by evaluation generation, clause ID, and normalized observation identity; retain late observations for audit without rewriting a terminal verdict. |

## Inter-module Interfaces

| Other Module | Direction | Contract |
|---|---|---|
| Work Orchestration | calls Evaluation | Pins a contract version on the Run, requests a generation after bounded Invocation work, and consumes a Verdict idempotently. It alone transitions Run state. |
| Collaboration | reads a successful Run/Verdict reference | Records explicit Thread Acceptance separately from the mechanical verdict. |
| Project Access | called by Evaluation | Provides a prepared read handle and path confinement for the pinned Local Project state. Evaluation supplies no mutation request and cannot upgrade access. |
| Authorization Grant / External Effect authority | peer dependency | Provides a valid command-authorization reference and the applicable effect-ledger generation. Evaluation records references only; it never creates a grant or changes effect state. |
| Coding Agent Runtime / Collaboration | supplies facts | May provide Artifact references and provenance-backed observations through Work Orchestration. Runtime completion and prose are inputs, never Verdicts. |
| Personal Developer through Collaboration | consumes results | Reads clause-level Evidence and Verdict, then submits an explicit acceptance/revision decision. It cannot retroactively rewrite the Verdict. |
| Tracker Integration | receives no completion authority | It may receive an authorized post-acceptance write-back elsewhere. Tracker state never supplies a Verdict. |

## Current-to-target mapping

| Current area | Actual current responsibility/evidence | Target decision |
|---|---|---|
| `packages/api/src/evidence/sqlite-evidence-store.ts:SqliteEvidenceStore` | Durable searchable knowledge/evidence-like records with FTS/vector retrieval. [CODE-CONFIRMED] | **Preserve implementation behaviour** for knowledge recall. **Replace as completion authority**: it lacks Run-bound artifact identity, contract clause verification, immutable verdict generations, and Result Contract semantics. |
| `packages/api/src/context/evidence-recall.ts` | Fail-open context enrichment. [CODE-CONFIRMED] | **Preserve implementation** as prompt-context recall only; it is not evaluation evidence. |
| `packages/api/src/sop/sop-loader.ts`, `sop-service.ts`, predicate implementations | Loads repository SOP and evaluates some trace predicates. [CODE-CONFIRMED] | **Preserve behaviour / adapt** as a source of configured repository gates and policy parsing; replace its current trace-centric result with contract clause Evidence and Verdicts. |
| `Task`/`TaskProgress`, messages, tool events, final replies | Current Thread-driven flow writes useful activity but has no Result Contract closure. [CODE-CONFIRMED] [current execution-path audit](../../audits/current-system/2026-07-22-thread-to-cli.md) §§4–6 | **Reference only** for execution activity; no current record is a canonical Result Artifact or Verdict. |
| Current audit and live database | Evidence graph currently has no demonstrated connection to Run completion; audit is best-effort. [CODE-CONFIRMED] [target snapshot](../../history/design-snapshots/2026-07-13-target-design-baseline-1.md#34-capability-closure-audit) and [current-path audit](../../audits/current-system/2026-07-22-thread-to-cli.md) | **Missing**: Result Contract versions, Artifact registry, verification Evidence, Verdict persistence, and recovery. |
| Symphony vertical slice | Defines scoped diff, configured gates, clean/known effect outcomes, structured verdict and restart cuts. [DOC-CLAIM] | **Preserve target behaviour** in this Module's clause and recovery rules; vertical-slice content is decomposed here rather than retained as a separate normative scenario. |

## Verification

Evaluation is complete only when real tests prove the Module Interface and its interaction with a real Local Project and repository gate:

1. a Run pins a contract version; later contract edits cannot alter its clause set;
2. a source diff/report Artifact is registered with stable identity and hash, and an out-of-scope/missing artifact is rejected or yields the correct clause result;
3. a configured repository gate runs through the pinned Project Access handle and stores command, environment, exit status, and output digest;
4. exit zero without the required Artifact, or agent text claiming success, cannot yield `satisfied`;
5. non-zero gate output yields clause-level `unsatisfied`; an unavailable environment/effect outcome yields `indeterminate`;
6. duplicate evaluation requests return one immutable Verdict for the same generation;
7. killing the process after Evidence and after Verdict separately recovers without fabricating success, losing evidence, or executing a non-idempotent gate twice;
8. a satisfied Verdict permits exactly one idempotent Work Orchestration transition to Run success, while no Verdict can accept the Thread;
9. reviewer Evidence is visible to the Personal Developer but cannot replace a required mechanical clause.

Fake-only evaluator tests establish contract logic, but not actual gate environment, Project Access, Artifact capture, or restart behavior.

## Open decisions

1. **Contract authoring location:** repository-maintained YAML versus a validated Chymia configuration record. The chosen format must compile to an immutable published contract version. [OPEN-DECISION]
2. **Gate observation timing:** whether Evaluation observes the same released mutation generation or a separately prepared immutable snapshot. Recommended first version: evaluate the pinned generation after mutation access is released, so verification never races active edits. [OPEN-DECISION]
3. **Artifact storage:** retain content in Chymia, retain only content-addressed filesystem/Git references, or use a hybrid. Minimum requirement is stable reference plus provenance/hash. [OPEN-DECISION]
4. **Future automatic acceptance:** even a fully mechanical satisfied Verdict does not automatically accept a Thread in the current target. If automatic acceptance is ever adopted, its rule and resulting Thread transition belong to Collaboration, not Evaluation. [OPEN-DECISION]
