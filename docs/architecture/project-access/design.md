# Project Access Design

> Status: **Canonical target-module draft; execution-placement policy remains open**
> Created: 2026-07-26
> Domain term: [Local Project](../../domain/CONTEXT.md)
> Evidence: current code uses `CHOCO_WORKSPACE`/`fileRoot`, Thread
> `projectPath`, and the Workspace UI for different meanings. [CODE-CONFIRMED]

## 1. Meaning and provenance

`Workspace` is not canonical Chymia language. Current code uses it for at least:

1. the configured filesystem root and default CLI working directory;
2. a Thread-specific `projectPath`;
3. the UI panel that exposes files, Git, tasks, memory, and audit views.

Those are not one object. The domain object is **Local Project**: the local
codebase or directory against which work is performed. An **execution
directory** is the resolved directory given to one Agent Invocation. It may be
the Local Project root or an isolated checkout; that choice is an execution
policy, not a second domain object.

The previous `Source Workspace`, `Isolated Workspace`, `Workspace Binding`, and
`Workspace Lease` names came from target-design inference influenced by
Symphony/Clowder. They are not confirmed current Chymia concepts. [INFERENCE]

## 2. Why this is a Module

Project Access qualifies as a Module because deleting it does not remove the
complexity. Canonical-path resolution, traversal and symlink confinement, file
and Git observation, working-directory preparation, concurrent mutation
control, and restart validation would reappear in Web routes, Coding Agent
Runtime, Evaluation, and Work Orchestration.

Its Interface gives those callers one answer to: “which Local Project and
execution directory may this operation use, under what access generation?”
The Implementation hides OS paths, Git/worktree mechanics, path confinement,
access fencing, and filesystem recovery. That is its Depth and Leverage.

This is not a general “workspace manager” and is not responsible for UI panels, Thread
state, permissions, CLI processes, evaluation, or tracker state.

## 3. Authoritative state

| State | Meaning | Persistence | Recovery rule |
|---|---|---|---|
| Local Project registration | Stable project ID, canonical root, observed filesystem identity, and availability | SQLite/config | Re-resolve the root; identity change or disappearance becomes unavailable |
| Project access generation | One prepared read or mutation access for a Run/Invocation, including execution directory, baseline, mode, expiry, and fencing token | SQLite plus filesystem/Git facts | Revalidate before reuse; stale generations cannot authorize mutation |
| Preparation/cleanup record | Durable requested and observed outcome for creating or cleaning an execution directory | SQLite | Unknown outcome remains unknown until reconciled |

An execution directory is a filesystem location described by a project access
generation. It is not independently a Thread, Run, or domain entity.

Project Access does not maintain Authorization Grants or External Effect records.
Work Orchestration supplies those references and is authoritative for the decision that an
operation is allowed.

## 4. Interface

```ts
interface ProjectAccess {
  register(input: RegisterLocalProject): Promise<LocalProjectRef>;
  prepare(input: PrepareProjectAccess): Promise<ProjectAccessHandle>;
  observe(input: ProjectObservationQuery): Promise<ProjectObservation>;
  release(input: ReleaseProjectAccess): Promise<ReleaseReceipt>;
  reconcile(input: ReconcileProjectAccess): Promise<ProjectAccessObservation>;
}
```

| Operation | Caller must supply | Result | Errors and idempotency |
|---|---|---|---|
| `register` | user-selected root | stable Local Project reference | nonexistent, unsafe, or identity-conflicting root; same identity returns same reference |
| `prepare` | project, Run/Invocation attribution, read/mutate mode, pinned baseline, authorization reference, idempotency key | opaque handle containing confined execution directory and fencing generation | unavailable project, baseline conflict, access conflict, expired authority; duplicate key returns original compatible handle |
| `observe` | handle plus a closed file/Git/artifact query | confined observation with provenance | path escape, sensitive path, stale handle, unavailable Git; no mutation is possible through this operation |
| `release` | handle and fencing generation | durable release receipt | stale generation cannot release a newer access; repeated release is a no-op receipt |
| `reconcile` | handle or startup scope | ready, unavailable, stale, preparation-unknown, or cleanup-unknown observation | never creates replacement access or guesses a safe outcome |

Callers know the Local Project reference, requested access mode, pinned
baseline, authorization reference, and returned handle. They do not know
absolute-path layout, worktree/copy mechanics, traversal checks, or fencing
arithmetic.

## 5. Seam and dependency classification

The external Interface lives between application Modules and local project
access. It is a natural test surface because Web file views, Coding Agent
Runtime, and Evaluation need the same confinement and identity rules.

Dependencies behind the Interface are:

| Dependency | Category | Design consequence |
|---|---|---|
| Path normalization and policy | In-process | Keep inside the Implementation; no Adapter |
| Local filesystem | Local-substitutable | Test through the Project Access Interface using temporary directories; internal seam only |
| Local Git executable/repository | Local-substitutable | Use real temporary Git repositories where behaviour matters; internal command seam only |
| Optional checkout/worktree strategy | Local-substitutable | An internal strategy may vary; do not expose a public Adapter until two production strategies are justified |

The earlier document incorrectly called local filesystem and Git “True
external” and exposed a broad manager Interface. They are local-substitutable,
so test seams remain internal. [INFERENCE]

## 6. Invariants and lifecycle

1. Every Thread that operates on files names one Local Project.
2. Every Agent Invocation receives exactly one prepared project-access handle.
3. Every path observed or passed to a CLI remains under the resolved execution
   directory after symlink resolution.
4. At most one live mutating generation may target the same mutable directory.
5. Fencing generations increase monotonically; stale holders cannot mutate or
   release a newer generation.
6. A configured/trusted root proves selection only; it does not grant arbitrary
   operations.
7. Missing roots, changed identity, unknown preparation, and unknown cleanup
   block unsafe reuse.

```text
requested -> preparing -> ready -> released
                     \-> unavailable
ready -> reconciling -> ready | unavailable | unknown
ready -> cleanup_pending -> cleaned | cleanup_unknown
```

Preparation is durable before filesystem mutation begins. `ready` is recorded
only after the execution directory and baseline are observed. Release is
terminal for one generation. Retry creates or resumes the same idempotent
preparation record; it does not invent a second directory.

## 7. Inter-Module Interfaces

| Module | Interaction |
|---|---|
| Work Orchestration | names the Local Project, access mode, baseline, Run/Invocation, and authorization reference; consumes handle and reconciliation facts |
| Coding Agent Runtime | receives one confined execution directory and fencing generation; cannot select another project or extend access |
| Evaluation | observes artifacts and Git/repository facts through read-only queries; cannot upgrade to mutation |
| Collaboration | may display project references but cannot resolve paths or grant access |
| Tracker Integration | has no direct project-access Interface |

## 8. Current-to-target mapping

| Current area | Actual meaning | Decision |
|---|---|---|
| `main.ts` `CHOCO_WORKSPACE` / `fileRoot` | one configured root used for UI file access and default CLI cwd [CODE-CONFIRMED] | Preserve behaviour as fallback Local Project input; stop calling it authoritative workspace state |
| Thread `projectPath` | per-Thread CLI cwd override [CODE-CONFIRMED] | Preserve behaviour as Local Project selection evidence; target selection remains part of the Thread |
| `path-sandbox.ts`, `workspace-security.ts` | path and sensitive-file checks [CODE-CONFIRMED] | Preserve implementation behaviour inside Project Access |
| workspace file/Git routes | real file, search, diff, status and reveal behaviour [CODE-CONFIRMED] | Preserve behaviour; route through the Project Access Interface |
| workspace trust store | persistent user trust for a configured root [CODE-CONFIRMED] | Preserve behaviour as project-selection eligibility, not execution authorization |
| isolated checkout, durable access generation, fencing and recovery | no production implementation [CODE-CONFIRMED] | Missing; isolation itself remains an open placement decision |

## 9. Verification

Tests use the Project Access Interface against temporary directories and real
temporary Git repositories. They must prove canonical identity, traversal and
symlink rejection, read-only observation, mutation conflict, stale fencing,
restart reconciliation, missing-root behaviour, and honest unknown outcomes.

Route-only tests and fake paths do not prove filesystem identity, Git state,
concurrent mutation control, or restart recovery.

## 10. Open decision

Whether a mutating Run operates directly in the Local Project root or in an
isolated checkout materially changes user experience and recovery. The current
code uses the selected root directly; isolated-per-Work-Item execution was an
unconfirmed target inference. The recommended target is an isolated Git
worktree when the Local Project is a Git repository, with explicit direct-root
mode only when the Personal Developer chooses it. [USER-DECISION]
