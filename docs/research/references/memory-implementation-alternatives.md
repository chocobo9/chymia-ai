# Memory Implementation Alternatives for Chymia

> Status: reference assessment; non-canonical
> Date: 2026-07-26
> Scope: local-first long-term Memory for a single-user Coding Agent orchestrator
>
> **Integration notice (2026-07-27):** the mechanism choices in this document
> remain reference inputs, but this document did not explain how they form one
> complete Chymia Module. The canonical
> [Memory Module design](../../architecture/memory/design.md) now supplies that
> integration, using Waku as the main structural reference and placing the
> Clowder, Letta and QMD mechanisms inside one Chymia Interface.

## 1. Mechanism recommendation

Clowder is a useful complete example, but it should no longer be the target
Memory Implementation.

The recommended Chymia direction is:

```text
Letta MemFS mechanism
  human-readable Markdown + Git history
                |
                v
Chymia Memory Module
  candidate review + provenance + redaction + policy
                |
                v
QMD retrieval Adapter
  BM25 + vector + hybrid + local reranking
```

This uses existing mature mechanisms for the difficult parts:

- Letta MemFS demonstrates Git-backed, directly editable agent memory;
- QMD supplies an on-device retrieval engine instead of Chymia developing one;
- Clowder supplies candidate-knowledge, provenance, secret scanning and
  fail-open rules;
- Git supplies diff, rollback and history.

Chymia-specific Implementation is limited to the product semantics that none of
the references can decide: which Run material may become a candidate, what
requires user confirmation, which Local Project it belongs to, what is placed
in an Invocation context, and how Memory degradation is reported.

For the fastest product experiment, Basic Memory is the strongest complete
external candidate. It should be evaluated through an Adapter without copying
its Implementation into Chymia.

## 2. What “better” means for Chymia

An implementation is better only if it improves the following without taking
control of Chymia's Coding Agent runtime:

1. local-first operation and data portability;
2. human inspection and correction;
3. explicit source and revision history;
4. project isolation;
5. Codex and Antigravity compatibility;
6. good lexical and semantic retrieval;
7. bounded LLM and background-process dependencies;
8. visible degraded operation;
9. no ability to silently turn model inference into project truth;
10. a small Memory Interface with high Depth.

Personalization benchmark scores alone do not establish suitability for a
Coding Project. A system optimized to remember user preferences can still be a
poor system for architecture decisions, repository facts and failed coding
attempts.

## 3. Required content separation

The references use the word memory for several different things. Chymia should
keep four kinds of content separate:

| Content | Meaning | Long-term truth? |
|---|---|---|
| Working Context | The bounded material inserted into one Invocation prompt | No; it can be rebuilt and discarded |
| Run Record | Messages, Tool calls, artifacts, results and failures | Durable execution record, but not automatically knowledge |
| Durable Memory | Confirmed project facts, user preferences, decisions and useful experience | Yes, after its admission rule succeeds |
| Skill | Versioned instructions for performing repeatable work | Separate Skill responsibility; not silently generated from Memory |

This separation prevents two common errors:

- treating every old message or Tool output as reusable knowledge;
- treating a model-generated “lesson” as an executable Skill.

Recommended scopes:

- Personal Memory: cross-project preferences explicitly attributable to the
  Personal Developer;
- Project Memory: decisions, constraints, commands and durable facts for one
  Local Project;
- Run material: complete historical record that may produce candidate Memory;
- CLI-private state: Codex/Antigravity internal state that Chymia does not
  present as shared Memory.

## 4. Candidate comparison

| Candidate | Strongest property | Main mismatch | Decision |
|---|---|---|---|
| Letta MemFS | Git-backed, editable Memory files for a coding agent | Tied to Letta's own agent Harness and long-lived agent identity | Adapt its file and history mechanisms |
| QMD | Mature on-device retrieval over Markdown and code | It does not decide what to remember or govern writes | Borrow as retrieval Adapter |
| Basic Memory | Most complete local Markdown + MCP product | AGPL, Python runtime and broad write Tool surface | External Adapter / product experiment |
| Clowder | Provenance, candidate lifecycle, scanners and fail-open behavior | Excess multi-agent, collection and graph complexity | Adapt governance mechanisms |
| LangMem | Clear formation policies for semantic, episodic and procedural memory | Python/LangGraph integration and no human-readable truth requirement | Borrow formation concepts |
| Mem0 OSS | Simple CRUD, broad integrations and personalization extraction | Vector-store-centered knowledge and weak human audit model | Reject as primary Implementation |
| Graphiti | Temporal facts, contradiction invalidation and graph retrieval | Graph database + LLM + embedding complexity | Reject until temporal relationships are a real user job |
| EverOS | Small `add/flush/search/get` Interface and Markdown truth | New external daemon, no built-in auth and eventual indexing | Optional Adapter candidate, below Basic Memory |
| Cognee | Broad ingestion and graph/vector pipelines | Large Python knowledge platform far beyond current need | Reference only |

## 5. Letta MemFS

### 5.1 Confirmed mechanisms

Letta Code is a memory-first Coding Agent Harness. Its local agents keep Memory
in an ordinary Git repository. MemFS synchronizes memory blocks to Markdown,
supports direct editing and keeps changes under Git history.

Primary evidence:

- [Letta Code repository and local-mode description](https://github.com/letta-ai/letta-code)
- [Memory filesystem Implementation](https://github.com/letta-ai/letta-code/blob/bd06074da707b4660ce151cf66446b73071c4091/src/agent/memory-filesystem.ts)
- [Memory write Tool](https://github.com/letta-ai/letta-code/blob/bd06074da707b4660ce151cf66446b73071c4091/src/tools/impl/memory.ts)
- [Memory patch Tool](https://github.com/letta-ai/letta-code/blob/bd06074da707b4660ce151cf66446b73071c4091/src/tools/impl/memory-apply-patch.ts)

The inspected Implementation includes:

- Markdown files for memory content;
- Git commits for accepted modifications;
- diff and patch operations;
- protection against writing outside the Memory path;
- read-only files;
- checks for dirty repository state;
- isolated worktrees for concurrent background work;
- a frequently loaded `system/` area and other files read on demand.

These mechanisms give callers strong Leverage: persistence, revision history,
rollback, human editing and concurrent-change handling sit behind a small file
and Git model.

### 5.2 What to adopt

- plain files as durable Memory;
- Git history for accepted Memory changes;
- frequently needed Memory separated from on-demand Memory;
- patch/diff review before destructive replacement;
- dirty-state and path-confinement checks;
- background consolidation isolated from the active execution.

### 5.3 What not to adopt

Letta is also an agent Harness. Replacing Codex/Antigravity with a Letta Agent
would invert Chymia's product structure. Chymia should adapt MemFS mechanisms,
not adopt Letta's runtime, agent identity or autonomous self-rewriting policy.

Automatic “dreaming” may generate candidates. It must not directly modify
project truth or executable Skills.

## 6. QMD

### 6.1 Confirmed mechanisms

QMD is an MIT-licensed on-device search engine with:

- Markdown indexing;
- SQLite FTS5;
- local embeddings and `sqlite-vec`;
- BM25, vector and hybrid retrieval;
- Reciprocal Rank Fusion;
- local LLM reranking;
- query expansion;
- CLI, MCP and library Interfaces;
- search-quality benchmarks;
- code chunking at function/class boundaries for supported languages.

Primary evidence:

- [QMD repository](https://github.com/tobi/qmd)
- [QMD package and dependencies](https://github.com/tobi/qmd/blob/main/package.json)
- [QMD releases and evaluation features](https://github.com/tobi/qmd/releases)

QMD's SQLite data is a rebuildable index. Markdown/code remains the readable
source material.

### 6.2 Why it is a good Adapter

QMD hides substantial retrieval complexity behind a small Interface. If it
were removed, tokenization, chunking, embedding, BM25, RRF, reranking, model
loading, GPU/CPU fallback and search evaluation would spread back into Chymia.
That is real Module Depth and Leverage.

QMD does not decide:

- what is worth remembering;
- whether a candidate contradicts accepted knowledge;
- whether a model may update or delete a fact;
- what source and confidence a Memory item has;
- whether a remembered procedure may become a Skill.

Those exclusions make QMD a good retrieval Adapter and a bad complete Memory
Module.

### 6.3 Integration constraint

Current QMD requires Node.js 22, while Chymia currently declares Node.js
`>=20.11` and CI uses Node.js 20. Direct library reuse would therefore require a
separate runtime decision. Running QMD as a local process/MCP Adapter avoids
coupling Chymia's main process to QMD's Node version, at the cost of process
management and health checks.

## 7. Basic Memory

Basic Memory is the strongest off-the-shelf product match:

- local-first Markdown;
- human and agent editing of the same files;
- SQLite-derived search and graph data;
- semantic search and relation traversal;
- native MCP;
- explicit Codex configuration;
- project selection;
- consistency checks and reindexing.

Primary evidence:

- [Basic Memory repository](https://github.com/basicmachines-co/basic-memory)
- [fixed inspected revision](https://github.com/basicmachines-co/basic-memory/tree/60408ad7d53e4ec448abaf04d0bfa222aa2f8e78)
- [technical and license information](https://docs.basicmemory.com/reference/technical-information)

It is the best candidate for a short real-user trial because it already closes
the file/index/MCP loop.

It is not the recommended embedded Implementation because:

- the code is AGPL-3.0;
- it adds Python/`uv` as a runtime dependency;
- its MCP surface includes broad write, move and delete operations;
- its Entity/Observation/Relation grammar may be unnecessary for Chymia;
- direct MCP exposure could bypass Chymia's candidate-admission rules.

Use it unchanged behind a narrow Adapter if license review and operational
testing are acceptable. Do not copy it into Chymia or expose all of its Tools as
the Chymia Memory Interface.

## 8. Clowder

Clowder remains the best inspected source for governance:

- provenance tiers;
- scanners over selected sources;
- secret scanning;
- candidate → review → materialize → reindex;
- separation of human-readable knowledge and rebuildable search data;
- explicit degraded search metadata;
- recall failure that does not stop the main Run.

These should be retained as target rules.

The following should not be copied into the initial Chymia Memory
Implementation:

- cross-project collection federation;
- broad entity/relationship graph machinery;
- multi-agent knowledge libraries;
- automated entropy and contradiction systems;
- product-specific Thread and community scanners;
- a large `MemoryServices` aggregate Interface.

## 9. LangMem

LangMem provides the clearest reusable vocabulary for memory formation:

- semantic memory: facts and knowledge;
- episodic memory: past experiences;
- procedural memory: behavior and instructions;
- hot-path formation initiated during interaction;
- background extraction and consolidation;
- schema-guided insert/update/delete behavior.

Primary evidence:

- [LangMem conceptual guide](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)
- [fixed extraction Implementation](https://github.com/langchain-ai/langmem/blob/56d85939d80bb731bd5e237567148d817d7bfd16/src/langmem/knowledge/extraction.py)

For Chymia, use the formation distinction but change one term: procedural
instructions that become repeatable executable guidance belong to Skill, not
Durable Memory.

LangMem's stateful integration is designed around Python and LangGraph stores.
Chymia should not introduce LangGraph to obtain concepts that can be expressed
inside its existing TypeScript runtime.

## 10. Mem0 OSS

Mem0 offers a mature `add/search/update/delete/history` surface, multiple model
and vector-store Adapters, metadata filters, reranking and optional graph
memory.

Primary evidence:

- [Mem0 OSS documentation](https://docs.mem0.ai/open-source/overview)
- [fixed Memory Implementation](https://github.com/mem0ai/mem0/blob/b357a5a1b03c299ec8229c268e63cfac0f7c6566/mem0/memory/main.py)
- [default local dependencies](https://docs.mem0.ai/open-source/python-quickstart)

It is a better fit for personalization and assistant preference memory than
for repository knowledge:

- an LLM extracts memories;
- embeddings and a vector store are central to operation;
- SQLite primarily records history rather than holding the readable knowledge;
- reviewing the complete current truth is less natural than reviewing files;
- extraction results can lose the strong relation to source text.

Chymia may borrow its CRUD ergonomics, filters, reranking and evaluation
approach. It should not make Mem0 its primary Project Memory Implementation.

## 11. Graphiti

Graphiti is strong when facts and relationships change over time. It records
episodes, extracts entities/edges, preserves temporal and provenance
information, invalidates outdated edges and performs hybrid graph/vector/full
text search.

Primary evidence:

- [Graphiti overview](https://help.getzep.com/graphiti/getting-started/overview)
- [fixed core Implementation](https://github.com/getzep/graphiti/blob/9140123a7282d44efc077a0af09179919f3defdf/graphiti_core/graphiti.py)
- [search strategies](https://help.getzep.com/graphiti/working-with-data/searching)
- [runtime requirements](https://help.getzep.com/graphiti/getting-started/quick-start)

It requires a graph database plus LLM and embedding configuration. That cost is
justified only if Chymia must answer questions such as “which relationship was
valid at a particular time?” across many projects. Current coding-memory jobs
can be represented through files, sources, Git history and Run records.

## 12. EverOS and Cognee

EverOS remains a viable small external Adapter because its
`add/flush/search/get` Interface separates interaction finalization from recall
and keeps Markdown as durable content. It is less attractive than Basic Memory
for an initial trial because the Golutra integration is not implemented, the
server has no built-in authentication and indexing is eventually consistent.

Cognee has mature ingestion, graph/vector storage, session capture and Coding
Agent hooks. Its Python pipeline, multiple databases and knowledge-platform
scope are substantially larger than Chymia's current user job. It is useful
reference evidence, not a target dependency.

Primary evidence:

- [EverOS API](https://github.com/EverMind-AI/EverOS/blob/64e0fdc9bbce996f751f053cff2a21809a46cd35/docs/api.md)
- [Cognee repository](https://github.com/topoteretes/cognee)

## 13. Recommended Memory Interface

The external Interface should stay independent of QMD, Basic Memory and any
future Adapter:

```text
recall(scope, query, budget) -> RecallResult
browse(scope, selector) -> MemoryView
captureCandidate(source, content, proposedScope) -> CandidateReceipt
decideCandidate(candidateId, decision) -> MemoryRevision
```

The Interface includes:

- Personal or Local Project scope;
- source references and accepted revision;
- result budget and degraded-mode metadata;
- candidate status;
- idempotency for repeated capture/decision;
- typed conflict, unavailable-index and invalid-source errors.

The Interface does not include:

- vector-store DTOs;
- QMD query syntax;
- Basic Memory Entity/Observation/Relation types;
- Letta block IDs;
- Run lifecycle transitions;
- Skill promotion;
- external-side-effect authorization.

This gives the Memory Module Depth: callers learn four operations while the
Implementation hides file layout, Git revisions, candidate conflict handling,
redaction, indexing, query routing, fallback and recovery.

## 14. Recommended write and recall lifecycle

```text
Run material
  -> candidate extraction
  -> source/redaction checks
  -> candidate record
  -> user or explicit policy decision
  -> Markdown patch
  -> Git commit
  -> QMD incremental reindex
  -> available for later recall
```

Recall:

```text
Context Assembly
  -> Memory.recall(scope, query, budget)
  -> QMD hybrid retrieval
  -> bounded source-backed excerpts
  -> degraded lexical/file fallback when needed
  -> Context Snapshot
```

Memory failure must not change Work Item, Run, Invocation or Evaluation state.
The user must be able to see that an Invocation ran without long-term recall.

## 15. Final adoption decision

**Borrow**

- QMD as the retrieval Implementation;
- Git-backed Markdown and patch/diff behavior demonstrated by Letta MemFS;
- Clowder provenance, candidate lifecycle, redaction and degraded-mode rules;
- LangMem's hot-path/background formation distinction.

**Adapt**

- Basic Memory as a trialable external Adapter;
- EverOS as a secondary Adapter candidate;
- Letta MemFS without Letta's Harness or autonomous identity semantics.

**Reference only**

- Mem0 evaluation and retrieval ergonomics;
- Graphiti temporal invalidation;
- Cognee ingestion and Coding Agent hook patterns.

**Reject for the current target**

- wholesale Clowder Memory Services;
- a vector database as the only readable knowledge store;
- automatic promotion of model output into durable truth or Skill;
- adopting Letta as the Coding Agent runtime;
- a graph database before temporal relationship queries are demonstrated;
- direct exposure of an external product's complete MCP Tool surface.
