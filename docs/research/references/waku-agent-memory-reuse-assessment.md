# Waku Agent Memory Reuse Assessment

> Status: reference assessment; non-canonical
> Date: 2026-07-27
> Inspected revision: `5f638cfb5de957c14f056027833d8a9df5bbe558`
> Question: can Chymia directly reuse Waku Agent's Memory Module?

## Conclusion

**Waku's Memory is a coherent and substantially complete Module inside Waku,
but it is not a drop-in Memory dependency for Chymia.**

The distinction is important:

- Chymia can legally reuse or modify the source because Waku is MIT licensed.
- Chymia cannot install a separately published `waku-memory` package or call a
  stable external Memory API; Waku publishes one Python application package.
- Reusing Waku unchanged means using its own model client, prompt assembly,
  Session and agent loop. That would replace the Codex/Antigravity CLI runtime
  that Chymia exists to coordinate.
- Extracting Waku's Memory behind a new local-process API, or translating it
  into Chymia's TypeScript runtime, is an adaptation. It is not direct reuse.

Therefore the target judgment is:

| Reuse form | Judgment | Reason |
|---|---|---|
| Import Waku Memory into Chymia's Node.js process | No | Python Implementation; not a separately versioned package |
| Call Waku Memory as an existing local service or MCP server | No | No Memory-only service Interface is supplied |
| Run the whole Waku application | No | Replaces Chymia's Coding Agent CLI Harness |
| Vendor a pinned Python subset and add a local API | Possible adaptation | MIT permits it, but Chymia must define and maintain the missing API and lifecycle |
| Reuse the design, schema ideas and deterministic cases | Yes | Clear, small, source-backed and compatible with local-first operation |

## What Waku actually implements

Waku presents one `Memory` facade over three kinds of material:

1. semantic Memory: durable facts in SQLite with FTS5 keyword retrieval;
2. episodic Memory: dated summaries in SQLite with FTS5 plus recency ordering;
3. procedural material: `SKILL.md` files selected by keyword overlap.

The facade also:

- asks a small model whether retrieval is needed;
- searches facts and episodes when retrieval is approved;
- records user and assistant messages;
- reloads a Session's conversation history;
- invokes consolidation after a configured number of exchanges;
- exports facts and episodes to a human-readable `MEMORY.md` projection.

Evidence:

- [Memory facade and Interface](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/memory/__init__.py)
  `[CODE-CONFIRMED]`
- [SQLite schema](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/db.py)
  `[CODE-CONFIRMED]`
- [fact store](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/memory/semantic/store.py)
  and [episode store](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/memory/episodic/store.py)
  `[CODE-CONFIRMED]`
- [retrieval decision](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/memory/retrieval_gate.py)
  and [consolidation](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/memory/consolidation.py)
  `[CODE-CONFIRMED]`
- [deterministic consolidation cases](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/evals/deterministic/test_consolidation.py)
  `[FAKE-ONLY]` for model behavior; the tests do use real SQLite bookkeeping.

The architecture diagram is therefore honest about the Module's internal
structure. Waku's README also maps each diagram box to a concrete source
directory. `[CODE-CONFIRMED]`

## Why the Module is clear

The `Memory` facade has good Depth for Waku's personal-assistant job. Its caller
asks for relevant Memory, matching Skills, conversation recording and periodic
consolidation without knowing the FTS schema or summarizer bookkeeping.

Waku also makes several strong choices that Chymia should retain as reference:

- one inspectable local SQLite file;
- bounded recent conversation context;
- raw conversation retained when consolidation fails;
- only rows actually read by a consolidation attempt are marked complete;
- FTS indexes maintained by database triggers;
- explicit human correction and deletion Tools;
- a generated Markdown view rather than pretending Markdown and the database
  are two independent truths;
- deterministic checks for thresholds, failure behavior and duplicate
  processing.

## Why direct reuse does not fit Chymia

### 1. The call chain is part of Waku's own Harness

Waku's production chain is:

```text
Waku.respond
  -> Session.build_system
  -> Memory.gated_retrieve + matching_skills
  -> Waku's model/tool loop
  -> Session.add_exchange
  -> Memory.log_chat
  -> Memory.maybe_consolidate
  -> Memory.export_markdown
```

The [composition root](https://github.com/ShenSeanChen/waku-agent/blob/5f638cfb5de957c14f056027833d8a9df5bbe558/waku/app.py)
constructs Memory, Session, Tools and the model loop together.
`[CODE-CONFIRMED]`

Chymia does not call an LLM API as its primary Coding Agent. It starts and
continues external Codex and Antigravity CLI Sessions. Waku's prompt insertion
and post-turn hooks cannot simply be imported into those CLI processes.

### 2. Waku has no Project-scoped Memory Interface

Waku's fact and episode records have no Project or Thread scope. Retrieval takes
only a text query. Consolidation selects every unconsolidated `chat_log` row in
the database, regardless of Session, and writes the result into shared fact and
episode tables. `[CODE-CONFIRMED]`

That is reasonable for one personal assistant identity. It is unsafe for a
Coding Agent control platform that works across multiple repositories:
unrelated project facts can be summarized together and recalled into the wrong
coding task.

Adding Personal/Project/Thread scope changes the schema, every write, every
query, consolidation, correction and recovery rule. It is a domain adaptation,
not configuration.

### 3. Waku combines Skill selection with Memory

Waku treats `SKILL.md` as procedural Memory and returns matching Skill bodies
through the same facade. Chymia already treats Skill as executable guidance
with its own selection and Tool implications. Keeping Skill inside Memory would
create two competing Skill paths.

The Waku loader is useful reference Implementation, but the Chymia target
should not redefine Skill as durable Memory merely to preserve Waku's facade.

### 4. The default search is lexical, not semantic similarity

Waku's default SQLite stores use FTS5/BM25 keyword matching. The word
“semantic” describes the fact type, not the retrieval algorithm. Vector search
requires the optional Supabase store. `[CODE-CONFIRMED]`

Chymia already has a TypeScript SQLite Evidence store with lexical and vector
paths, provenance fields, entity relations and degraded-search metadata at
`packages/api/src/evidence/sqlite-evidence-store.ts`. Replacing it with Waku's
default tables would discard existing behavior and data structure rather than
complete the missing Memory lifecycle.

### 5. Multi-execution consolidation is not defined

Waku protects rows that arrive while one consolidation call is running, but
there is no durable claim preventing two simultaneous consolidation workers
from reading the same rows and writing duplicate facts. Its normal application
serializes turns in one local Harness. `[CODE-CONFIRMED]`

Chymia can have multiple CLI Invocations and Threads. A direct transplant would
leave duplicate processing and cross-project mixing unresolved.

### 6. The model Interface is Waku-specific

Retrieval decisions and consolidation call a client exposing the Anthropic
`client.messages.create` shape and use Waku's configured small model. Waku's
provider layer adapts several API providers to that shape, but it does not use
the stateful Codex or Antigravity CLI Session as this auxiliary model.

Introducing Waku unchanged therefore adds a Python runtime and a separate API
model configuration rather than reusing the Coding Agent CLI relationship that
Chymia already maintains.

## What “reuse Waku” can honestly mean

The broadest honest reuse is **adapt the complete behavioral design as one
reference**, not assemble unrelated memory products:

```text
raw completed CLI exchanges
  -> bounded working context
  -> scope-aware retrieval decision
  -> fact/episode recall
  -> threshold-based consolidation
  -> inspect/correct/delete
  -> one visible durable record plus rebuildable search data
```

Waku supplies a coherent baseline for this lifecycle and strong deterministic
cases. Chymia must still define the parts that arise from its different product:

- Personal versus Project scope;
- Thread and Run source references;
- injection into Codex/Antigravity CLI Invocations;
- concurrent consolidation;
- separation between Memory and Skill;
- use of Chymia's existing Evidence data;
- correction, contradiction and deletion rules across projects.

These are not optional embellishments. Without them, the reused Module would
not preserve Chymia's core coding work correctly.

## Decision

**Do not adopt Waku Agent as a runtime dependency and do not describe its
Memory as directly reusable.**

Use Waku as the primary clarity and lifecycle reference for Chymia's Memory
design. Preserve Waku's small facade, local inspectability, raw-log retention,
threshold consolidation, explicit correction and deterministic failure cases.
Adapt the state model and Interface to Chymia's Project/Thread/Run semantics and
existing TypeScript persistence.

The earlier proposal to combine Letta MemFS, QMD and Clowder mechanisms remains
valid as a set of mechanism choices, but its presentation was incomplete
because it did not integrate them into one Module. The canonical
[Memory Module design](../../architecture/memory/design.md) now uses Waku as
the main structural reference and explains how those mechanisms cooperate
behind one Chymia Interface.
