# Tool, Skill and Memory Reference Adoption Assessment

> Status: reference assessment; non-canonical
> Last consolidated: 2026-07-26
> Scope: Clowder, Golutra, golutra-mcp and EverOS evidence relevant to Chymia
> Rule: this document may recommend mechanisms; it cannot define Chymia target behavior
>
> Integration update (2026-07-27): Memory now qualifies as a target Module.
> Its complete target behavior is defined only by the canonical
> [Memory Module design](../../architecture/memory/design.md).

## 1. Conclusion

Chymia should not invent a combined “Tool / Skill / Memory capability layer.”
The references support three different responsibilities:

| Concern | What it means | Recommended source |
|---|---|---|
| Tool | A typed operation that a CLI or MCP host can invoke | Preserve Chymia's authenticated MCP callback path; adapt Clowder toolsets and `golutra-mcp` result/confirmation patterns |
| Skill | Versioned instructions that teach a Coding Agent how to perform a kind of work | Adapt Clowder's `SKILL.md` catalog, dependency declaration and provider mounting |
| Memory | Recall and durable knowledge derived from project material and prior interactions | Reuse Clowder's core memory pipeline; keep EverOS behind an optional Adapter until a real integration is verified |

The Coding Agent CLI keeps its own internal tool loop. Chymia does not need to
reimplement Codex or Antigravity file, shell, browser or general MCP behavior.
Chymia exposes only Chymia-specific operations, supplies approved project
scope, assembles context, records observable effects and receives structured
results. [INFERENCE]

Golutra's public claims are not sufficient evidence of completed Skill workflow
or Memory integration. Its main repository currently provides terminal
orchestration and Skill folder mounting; the more complete Tool design is in
`golutra-mcp`, and the Memory product it links is EverOS. [CODE-CONFIRMED]
[DOC-CLAIM]

## 2. Evidence baseline

### 2.1 Clowder

The inspected Clowder snapshot is
[`reference/clowder-ai-main`](../../../reference/clowder-ai-main). Relevant
production sources include:

- Tool registration and least-privilege filtering:
  [`packages/mcp-server/src/server-toolsets.ts`](../../../reference/clowder-ai-main/packages/mcp-server/src/server-toolsets.ts)
- Memory composition:
  [`packages/api/src/index.ts`](../../../reference/clowder-ai-main/packages/api/src/index.ts)
  and
  [`domains/memory/factory.ts`](../../../reference/clowder-ai-main/packages/api/src/domains/memory/factory.ts)
- Memory Interfaces:
  [`domains/memory/interfaces.ts`](../../../reference/clowder-ai-main/packages/api/src/domains/memory/interfaces.ts)
- Skill catalog and MCP dependency resolution:
  [`utils/skill-parse.ts`](../../../reference/clowder-ai-main/packages/api/src/utils/skill-parse.ts)
- Provider-specific Skill mounting:
  [`utils/skill-mount.ts`](../../../reference/clowder-ai-main/packages/api/src/utils/skill-mount.ts)
- Skill security scan:
  [`skill-security/content-scanner.ts`](../../../reference/clowder-ai-main/packages/api/src/skill-security/content-scanner.ts)
- Memory architecture decision:
  [`ADR-020`](../../../reference/clowder-ai-main/docs/decisions/020-f102-memory-system-architecture.md)
- Skill distribution decision, explicitly marked drifted:
  [`ADR-009`](../../../reference/clowder-ai-main/docs/decisions/009-cat-cafe-skills-distribution.md)

Clowder is MIT licensed. Its code can be reused subject to the license, but its
multi-user and multi-agent product semantics still require a Chymia-specific
design decision. [REFERENCE]

### 2.2 Golutra and related repositories

The Golutra evidence uses fixed official revisions:

- Golutra `8b68a14183afa6ec26f9905f2a81cbd91ed1b35b`
- golutra-mcp `64be8705e47ca35b19a89000183e9fa9ca627487`
- EverOS `64e0fdc9bbce996f751f053cff2a21809a46cd35`

Golutra's main repository is BSL 1.1. Its Implementation must not be copied into
Chymia without a separate license check. `golutra-mcp` and EverOS use Apache
2.0. [REFERENCE]

## 3. Current Chymia reality

| Concern | Production path | What is real | Current limit |
|---|---|---|---|
| Tool | `main.ts` → `buildApp` → `buildInvokeAgentFn` → provider MCP config → `packages/mcp-server` → authenticated callback routes | Codex/Claude/Gemini-specific MCP delivery, invocation token, callback authentication, nine registered tools, tool-event records | One undifferentiated server; file tools duplicate CLI abilities; external MCP installation is UI-only; live invocation authorization is process memory |
| Skill | `buildApp` → `SkillService` → `skillBlock()` → every Invocation system prompt | Manifest validation, persistent enablement flag and real prompt injection | Uses `<id>.md`, not portable `SKILL.md`; concatenates every enabled Skill on every turn; no version pinned to the Invocation; several inherited multi-agent Skills do not fit Chymia's target scope |
| Memory | `buildApp` → `SqliteEvidenceStore`; `buildInvokeAgentFn` → `buildHierarchicalContext` → `recallEvidence`; Web → `/api/evidence/search` | SQLite records, FTS, entity/edge data, best-effort recall, Web search UI | No scanner/index-build/materialization lifecycle; manual upsert is the main write path; “semantic” query uses a lexically found stored vector rather than a real query embedding |

All three paths are `[CODE-CONFIRMED]`. None is a complete target design.

### 3.1 Important current behavior to preserve

- Provider-specific MCP configuration is hidden behind provider Adapters.
- MCP callbacks require an Invocation identity and token.
- Tool results and tool events can be observed after execution.
- Skill enablement changes the real next Invocation prompt.
- Memory recall times out and fails open, so a retrieval outage does not block
  the Coding Agent.
- The Memory store uses local SQLite and supports lexical retrieval without a
  remote service.

### 3.2 Current behavior that is misleading

`SqliteEvidenceStore.semanticSearch()` does not embed the user's query. It first
performs lexical search and reuses the vector of a matching stored item as a
“more like this” seed. It therefore does not provide general semantic search
for a query with no lexical foothold. The UI and target design must not describe
this as a complete semantic-memory path. [CODE-CONFIRMED]

The current Skill manifest says the platform does not match triggers and that
the agent self-selects, but `SkillService.block()` injects the full text of every
enabled Skill on every turn. “Enabled” currently means “always included,” not
“available for on-demand discovery.” [CODE-CONFIRMED]

## 4. Tool assessment

### 4.1 What Clowder proves

Clowder groups tools by real purpose instead of exposing one flat catalog:
collaboration, memory, signals, runtime limb and audio. In read-only mode, new
tools are excluded unless explicitly allowlisted. A second allowlist enables a
small set of authenticated write operations. [CODE-CONFIRMED]

Clowder also removed generic file read/write/list tools because supported
Coding Agent CLIs already provide file operations. Its design reason was both
reduced prompt footprint and avoidance of duplicate behavior. [REFERENCE]

The reusable principle is not “always create several MCP servers.” It is:

> Expose the smallest operation set needed for the current Invocation, grouped
> where permission, dependency or prompt-footprint differences are real.

### 4.2 What golutra-mcp proves

The actual chain is:

```text
MCP Tool schema
  -> ContextStore
  -> GolutraCliGateway
  -> golutra-cli
  -> running Golutra application
```

Sources:

- [Tool schemas and handlers](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/toolkit.ts)
- [CLI Adapter](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/golutra-client.ts)
- [Process runner, timeout and JSON parsing](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/cli-runner.ts)
- [Per-call context override](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/context.ts)
- [Structured results](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/tool-results.ts)

It uses typed input, structured success/error output, per-call project override,
bounded process execution and explicit repeated identifiers for destructive
actions. These are useful Interface patterns. [CODE-CONFIRMED]

Its risk classification is descriptive text rather than an enforceable
authorization decision, and its `ContextStore` persistence lasts only for the
MCP process. Chymia must not mistake either for a durable security guarantee.
[CODE-CONFIRMED]

### 4.3 Adoption decision

**Borrow**

- typed Tool schema and structured result;
- explicit read / mutate / destructive classification;
- explicit confirmation for destructive operations;
- per-call Local Project scope;
- limited retry only for a classified transient connection failure;
- Clowder's allowlist-default behavior and purpose-specific toolsets.

**Adapt**

- preserve Chymia's direct MCP-to-internal-Interface callback path rather than
  adding a `chymia-cli` hop;
- convert risk labels into executable authorization checks;
- redact secrets and bound stdout/stderr before recording or returning results;
- expose only Chymia-specific operations: collaboration, Memory, Session and
  work-control operations that the Coding Agent CLI does not already provide;
- split the current server only when a real permission, dependency or prompt
  footprint difference appears.

**Reject**

- a generic command plus arbitrary payload Interface;
- generic file and shell wrappers already supplied by the CLI;
- permission expressed only in Tool descriptions;
- retrying an operation whose external outcome is unknown;
- copying Golutra's BSL Implementation.

## 5. Skill assessment

### 5.1 What Clowder proves

Clowder uses a repository catalog containing `SKILL.md` files plus manifest
metadata such as description, triggers and required MCP servers. It can inspect
whether required MCP dependencies are ready and mount Skills into
provider-specific project or user directories. [CODE-CONFIRMED]

This gives a useful separation:

```text
Skill source
  -> validate metadata and dependencies
  -> make available to one provider/project
  -> provider loads instructions
  -> tools remain separately authorized
```

Clowder's first user-level symlink policy later drifted when project-level
mounting was added. The reusable mechanism is a single source plus
provider-specific Adapters, not its old symlink policy. [REFERENCE]

The regex content scanner is defense in depth only. It does not make arbitrary
Skill content trusted and should not be copied as a complete security design.
[INFERENCE]

### 5.2 What Golutra proves

Golutra can import a directory into a personal Skill library and link selected
directories into `.golutra/skills` for a project:

- [personal Skill library](https://github.com/golutra/golutra/blob/8b68a14183afa6ec26f9905f2a81cbd91ed1b35b/src-tauri/src/ui_gateway/skills.rs)
- [project Skill links](https://github.com/golutra/golutra/blob/8b68a14183afa6ec26f9905f2a81cbd91ed1b35b/src-tauri/src/ui_gateway/project_skills.rs)

`golutra-mcp` can discover a project Skill, read `SKILL.md` and invoke a CLI
validator:

- [project Skill discovery](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/project-skills.ts)
- [Skill Tool handlers](https://github.com/golutra/golutra-mcp/blob/64be8705e47ca35b19a89000183e9fa9ca627487/src/lib/toolkit.ts)

The main Golutra repository does not parse or trigger `SKILL.md`, insert it into
an agent prompt, execute a workflow state machine, or record the Skill version
used by an execution. Its advertised custom workflows and template import/export
remain `[DOC-CLAIM]`, not a reusable production workflow engine.

### 5.3 Adoption decision

**Borrow**

- `SKILL.md` as the portable, human-readable Skill entry;
- one source catalog and an explicit per-project enabled set;
- manifest validation and declared Tool/MCP dependencies;
- provider-specific installation or discovery Adapters;
- a Skill validator before the Skill becomes available.

**Adapt**

- keep a stable catalog reference instead of treating Windows symlinks as the
  only valid binding;
- pin Skill identity and content digest to each Invocation that uses it;
- provide a concise available-Skill catalog and load full instructions only
  when selected, subject to the real Codex/Antigravity Adapter behavior;
- let Context Assembly select and load Skills; a Tool Adapter must not trigger
  a Skill by itself;
- treat a Skill as instructions that may call Tools, never as permission to use
  those Tools;
- review the inherited Chymia manifest and remove multi-agent or Clowder-specific
  Skills from the single-agent default catalog.

**Reject**

- treating “enabled” as unconditional full prompt injection forever;
- treating the existence of a folder or symlink as an execution workflow;
- adding a Workflow Module based only on Golutra's README;
- automatically promoting remembered behavior into an executable Skill;
- a marketplace, conflict-resolution system or global synchronization system
  before Chymia has a verified need.

## 6. Memory assessment

### 6.1 The mature Clowder core

Clowder's production composition creates:

```text
source scanners
  -> IndexBuilder
  -> SQLite evidence store + FTS
  -> optional embedding/vector Adapter
  -> KnowledgeResolver
  -> recall

candidate knowledge
  -> MarkerQueue
  -> review
  -> MaterializationService
  -> durable Markdown
  -> incremental reindex
```

Its principal Interfaces are `IEvidenceStore`, `IIndexBuilder`,
`IKnowledgeResolver`, `IMarkerQueue`, `IMaterializationService`,
`IReflectionService` and optional `IEmbeddingService`. [CODE-CONFIRMED]

The most important truth distinction is:

- human-readable project documents are durable knowledge;
- SQLite search tables and vectors are compiled, rebuildable retrieval data;
- candidate knowledge is not durable truth until reviewed and materialized.

This is the mature design Chymia should reuse. It prevents search indexes,
generated summaries and model guesses from silently becoming project truth.

Clowder's full current implementation also includes collection federation,
knowledge graphs, entity aliases, contradiction tracking, review cycles,
cross-project libraries and several product-specific scanners. Those are not
required to obtain the core Memory Depth. [REFERENCE]

### 6.2 What EverOS proves

Golutra's README says it can call EverOS, but the inspected Golutra production
path contains no EverOS client, Memory configuration, scope mapping or failure
handling. The integration is `[DOC-CLAIM]`.

EverOS itself is an independent local Memory product with four small operations:

```text
add(messages)
flush(session)
search(query)
get(type, filters)
```

Sources:

- [API](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/docs/api.md)
- [write pipeline](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/src/everos/service/memorize.py)
- [search pipeline](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/src/everos/service/search.py)
- [architecture](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/docs/architecture.md)
- [storage layout](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/docs/storage_layout.md)

Its write flow buffers a session, detects a boundary, extracts memory through
an LLM, writes Markdown and updates search indexes asynchronously. Markdown is
the durable memory content; SQLite carries buffers, audit/sync jobs and offline
task state; LanceDB carries retrieval indexes. [CODE-CONFIRMED]

The API is loopback by default and has no built-in authentication. Extraction
requires an LLM. Vector/hybrid/rerank modes require additional model
configuration. An accepted write may not be immediately searchable because
indexing is asynchronous. [CODE-CONFIRMED]

### 6.3 Adoption decision

**Borrow from Clowder**

- scanners, rebuildable index and resolver as separate Implementations;
- Markdown/document truth separated from retrieval data;
- provenance tiers and explicit degraded search metadata;
- lexical retrieval as the dependency-light baseline;
- optional embedding Adapter and fail-open degradation;
- candidate → review → materialize → reindex lifecycle;
- Memory recall as bounded context enrichment, never execution authority;
- Skills indexed as references only, without copying their complete content
  into Memory.

**Adapt**

- start with project documents, selected Thread/Session summaries and manually
  approved knowledge; do not enable every Clowder scanner;
- reuse Chymia's SQLite store and fail-open recall behavior, but replace its
  pseudo-semantic query path with a real query-embedding Adapter or label it
  lexical-only;
- keep Memory knowledge separate from Evaluation Evidence: Memory helps the
  agent remember, while Evaluation Evidence proves a Result Contract clause;
- bind recall to a stable Local Project identity and the context being assembled;
- redact secrets and large Tool output before a candidate enters Memory.

**Adapt EverOS only behind a Seam**

If EverOS is later selected, Chymia should depend on a small Interface such as:

```text
recordInteraction(...)
finalizeInteraction(...)
recall(...)
browse(...)
```

An EverOS Adapter may translate those operations to `add`, `flush`, `search`
and `get`. Other Modules must not depend on EverOS HTTP DTOs. Each Invocation
should have an unambiguous Memory session mapping; `flush` occurs at Invocation
termination; an outage produces a visible “running without long-term Memory”
degraded mode. [INFERENCE]

**Reject**

- allowing Memory to decide Work Item, Run, Invocation or Session lifecycle;
- allowing recalled text to authorize an external side effect;
- copying Clowder's complete federation, graph and automated entropy machinery
  into the first Chymia design;
- enabling EverOS profiles, foresight, multimodal extraction or generated
  Skills before a demonstrated user job;
- modifying EverOS Markdown, SQLite or LanceDB behind its API;
- calling Golutra's README statement a completed Memory integration;
- calling a model-extracted pattern an executable Skill without validation and
  explicit promotion.

## 7. Module and Seam consequences for the architecture diagram

The future diagram should show:

```text
Coding Agent Runtime
  -> Codex / Antigravity CLI
       -> CLI's own Tool loop

Chymia Tool Interface
  -> typed Chymia-specific operations
  -> authorization check
  -> internal Module Interface or external Adapter
  -> structured, redacted result

Skill Catalog
  -> validate and select for Local Project
  -> pin version for Invocation
  -> Context Assembly loads instructions on demand
  -> Skill may request Tool use but cannot authorize it

Memory Interface
  -> record / finalize / recall / browse
  -> Clowder-derived local Implementation
  -> optional EverOS Adapter
```

This research did not itself prove that Tool, Skill or Memory must each be a
top-level Chymia Module. The later architecture review applied the Module test
and confirmed Memory because admission, accepted knowledge, revision,
processing and index-health state have one source of truth behind a small
Interface. The remaining comparisons are:

1. Skill Catalog as part of Context Assembly versus a separate deep Module;
2. one small Chymia MCP server versus purpose-specific toolsets.

## 8. Decisions that can be made now

1. Preserve Chymia's authenticated MCP callback path and provider-specific MCP
   configuration.
2. Stop treating generic file tools as a Chymia product responsibility.
3. Use `SKILL.md` plus manifest/dependency validation as the target portable
   format; do not preserve the current `<id>.md` shape as a compatibility rule.
4. Do not model Skill as Tool or as automatic permission.
5. Reuse the Clowder Memory core instead of designing a new retrieval and
   materialization model.
6. Preserve the Chymia SQLite/FTS and fail-open behaviors, but do not claim
   complete semantic Memory.
7. Treat EverOS as an optional local external dependency candidate, not as
   Golutra functionality already proven to work.
8. Do not add a Workflow Engine based on Golutra's product copy.

## 9. Decisions still requiring evidence

These are technical validation questions, not user product choices:

- whether Antigravity can discover or load `SKILL.md` natively and how its
  project-level Skill Adapter must work;
- whether Chymia's first usable version needs external EverOS at all after the
  Clowder-derived local Memory core is restored;
- which Chymia-specific Tools are needed for the first single-agent workflow;
- whether the resulting Tool count or permission split justifies multiple MCP
  toolsets;
- which Thread/Session material may enter long-term Memory automatically and
  which requires review.

No product-level question blocks the next architecture diagram. The diagram
should mark these points as Adapter or policy decisions rather than inventing
finished behavior.
