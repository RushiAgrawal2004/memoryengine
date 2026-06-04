# Memory Engine Build Report

Generated for the current local project state.

## Executive Summary

Memory Engine is now a functional local MVP for repo-grounded memory for coding agents. It can run as an HTTP daemon, expose MCP tools to Codex/Claude-style agents, activate memory per chat session, store durable memories, retrieve memories with hybrid recall, write a lightweight knowledge graph, track repo grounding metadata, run consolidation passes, expose automatic hook capture, and show the stored state in a useful dashboard.

The project is built end-to-end as a local system. It is not yet fully proven as a public product claim because the default providers are local heuristic fallbacks, the benchmark is still a smoke/regression benchmark, and some dashboard concepts such as lessons/actions/crystals/replay are visible as honest placeholders rather than complete subsystems.

## Product Goal

The project goal is to build the best memory layer for AI coding agents:

```txt
agentmemory-style ease
plus repo grounding
plus temporal correctness
plus code-change awareness
```

The differentiator is not generic memory. The differentiator is:

```txt
Memory that knows when code facts may become stale.
```

That means the engine is designed around:

- project scopes
- chat sessions
- durable memories
- episode capture
- repo refs
- file/symbol anchors
- temporal validity
- invalidation instead of blind append-only memory
- graph recall
- staleness auditing
- automatic capture after activation

## Current Architecture

The system is built around this flow:

```txt
Agent / CLI / Hook
  -> HTTP daemon or MCP stdio server
  -> activate/search/remember/audit tools
  -> episode capture
  -> fact extraction
  -> memory operation decision
  -> memories table
  -> entities/edges graph tables
  -> hybrid retrieval
  -> dashboard/viewer
  -> consolidation/audit loops
```

Main runtime pieces:

- HTTP server: `src/index.ts`
- CLI: `src/cli.ts`
- MCP server: `src/mcp/server.ts`
- DB schema: `src/db/schema.ts`
- Memory activation: `src/memory/activate.ts`
- Scope normalization: `src/memory/scope.ts`
- Remember pipeline: `src/write/remember.ts`
- Capture pipeline: `src/write/capture.ts`
- Fact extraction: `src/write/extract.ts`
- Memory operations: `src/write/memory-ops.ts`
- Retrieval: `src/read/retrieve.ts`, `src/read/recall.ts`, `src/read/fuse.ts`
- Graph writes: `src/graph/entities.ts`, `src/graph/edges.ts`, `src/graph/write.ts`
- Repo grounding: `src/grounding/git.ts`, `src/grounding/staleness.ts`
- Consolidation: `src/consolidate/loop.ts`
- Dashboard: `src/viewer/routes.ts`, `src/db/viewer.ts`

## Built Features

### 1. HTTP Daemon

The server runs locally on port `3777` by default.

Implemented routes:

- `GET /health`
- `POST /save`
- `POST /search`
- `POST /activate`
- `POST /remember`
- `POST /hook/capture`
- `GET /viewer`
- `GET /viewer/data/overview`
- `GET /viewer/data/memories`
- `GET /viewer/data/sessions`
- `GET /viewer/data/entities`
- `GET /viewer/data/edges`
- `GET /viewer/data/episodes`
- `GET /viewer/data/activity`
- `GET /viewer/data/audit`
- `GET /viewer/data/profile`
- `GET /viewer/data/graph`

The daemon can be started with:

```powershell
memoryengine
```

or in development:

```powershell
npm run dev
```

### 2. CLI

The project now installs a global local CLI:

```powershell
npm run build
npm install -g .
```

Commands implemented:

- `memoryengine`
- `memoryengine start`
- `memoryengine serve`
- `memoryengine demo --reset`
- `memoryengine activate --task "..."`
- `memoryengine connect codex`
- `memoryengine connect claude-code`
- `memoryengine hook-test --scope "..."`
- `memoryengine doctor`

Important CLI fixes already completed:

- Global CLI now works outside the `E:\memoryengine` folder.
- `memoryengine connect codex` now points MCP config to the real installed server path, not the current project folder.
- CLI detects when the HTTP server is already running.
- `hook-test` can smoke-test automatic hook capture.

### 3. MCP Tools

The MCP server exposes these tools:

- `memory.activate`
- `memory.search`
- `memory.remember`
- `memory.save`
- `memory.audit`

The intended safe workflow is:

```txt
memory.activate first
memory.search as needed
memory.remember only with the returned session.id
memory.audit before trusting stale code-grounded facts
```

Important behavior:

- MCP config only makes tools available.
- It does not store memory by itself.
- Storage is opt-in per activated chat window.
- `memory.remember` requires a `sessionId`.
- Unactivated chats cannot write memory through `memory.remember`.

### 4. Chat Session Activation

The engine supports plugin-style chat sessions.

When a chat calls `memory.activate`, the system:

- resolves a project scope
- creates a row in `chat_sessions`
- returns a `session.id`
- searches existing memories for the task
- returns dashboard URL and instructions

Sessions are stored in `chat_sessions` with:

- id
- scope
- task/title
- agent
- status
- repo ref
- started/ended timestamps

Important fix:

- Bare scope `project` is normalized into a concrete scope like `project:MEMORY ENGINE TEST`.

### 5. Opt-In Memory Writes

The engine now enforces safe write behavior:

- `/remember` requires an active session id.
- MCP `memory.remember` requires an active session id.
- Wrong-scope sessions are rejected.
- Ended or missing sessions are rejected.

This matches the product requirement:

```txt
Only the chat/window where memory was activated should store memory.
```

### 6. Automatic Capture Hooks

Hook scripts exist under:

- `hooks/codex`
- `hooks/claude-code`
- `hooks/lib/memory-hook.mjs`

Implemented hook behavior:

- Hooks post to `/hook/capture`.
- `/hook/capture` finds the latest active session for the project scope.
- If no active session exists, it skips capture safely.
- If an active session exists, it writes to that session automatically.

This means the user should only need to activate memory once per chat. After that, hook capture can happen automatically if the agent/editor hook system is configured to call the scripts.

Smoke-test command:

```powershell
memoryengine hook-test --scope "project:MEMORY ENGINE TEST"
```

### 7. Persistence Schema

The schema includes:

- `chat_sessions`
- `episodes`
- `memories`
- `entities`
- `edges`

Memory rows include:

- type
- scope
- content
- embedding JSON fallback
- optional pgvector mirror column via migration
- FTS generated column
- confidence
- status
- temporal validity fields
- source episode/session
- repo ref
- anchors
- attrs
- supersedes
- use count
- last used timestamp

Graph rows include:

- entities
- edges
- relation facts
- temporal validity
- source episode

### 8. Embeddings Provider

Implemented:

- `Embeddings` interface
- hosted embeddings provider
- local deterministic fallback provider
- provider factory
- batching up to 100 texts
- backfill script

Files:

- `src/providers/embeddings.ts`
- `src/scripts/backfill-embeddings.ts`

The local default works without API keys.

Hosted provider can be enabled with:

```env
EMBEDDINGS_PROVIDER=hosted
EMBEDDINGS_API_KEY=...
EMBEDDINGS_MODEL=...
EMBEDDINGS_BASE_URL=...
```

### 9. pgvector Support With Fallback

The project supports:

- JSON embedding fallback
- optional pgvector columns
- vector sync helper
- pgvector recall when available
- local cosine fallback when pgvector is unavailable

Files:

- `src/db/embedding-vectors.ts`
- `drizzle/0002_optional_pgvector.sql`

This lets the system work locally without pgvector and upgrade to Neon/pgvector later.

### 10. Hybrid Retrieval

The retrieval pipeline includes:

- vector recall
- full-text search recall
- graph recall
- reciprocal rank fusion
- optional reranking

Files:

- `src/read/recall.ts`
- `src/read/fuse.ts`
- `src/read/retrieve.ts`

Implemented recall sources:

- `vectorRecall`
- `ftsRecall`
- `graphRecall`

Implemented fusion:

- RRF in `src/read/fuse.ts`

Search can also use `asOf` for time-travel-style retrieval.

### 11. Reranker Provider

Implemented:

- `Reranker` interface
- Cohere reranker implementation
- local fallback/no-op reranker
- provider factory

File:

- `src/providers/rerank.ts`

Default is:

```env
RERANK_PROVIDER=none
```

Cohere can be enabled later.

### 12. LLM Provider

Implemented:

- `LLM` interface
- `json<T>(system, user, schema)`
- `chat(system, user)`
- hosted OpenAI-compatible implementation
- local heuristic fallback

File:

- `src/providers/llm.ts`

Default is local heuristic mode. Hosted mode can be enabled with:

```env
LLM_PROVIDER=hosted
LLM_API_KEY=...
LLM_MODEL=...
LLM_BASE_URL=...
```

### 13. Fact Extraction

The write pipeline extracts:

- atomic facts
- entities
- relations

File:

- `src/write/extract.ts`

Current limitation:

- With local provider, extraction is heuristic.
- Real messy natural-language extraction needs hosted LLM validation.

### 14. Memory Operation Pipeline

The core intelligent write pipeline is implemented:

- `ADD`
- `UPDATE`
- `INVALIDATE`
- `NOOP`

File:

- `src/write/memory-ops.ts`

Behavior:

- For each extracted fact, retrieve similar active memories.
- Ask LLM provider to choose an operation.
- Apply the operation.
- `INVALIDATE` marks old memory invalid and expired.
- New replacement memory can point to `supersedes`.
- Writes run inside a DB transaction.
- Memories are tied to source episode/session when available.

Acceptance behavior exists:

```txt
"we use npm"
then "we switched to pnpm"
=> npm memory invalid, pnpm memory supersedes it
```

### 15. Bi-Temporal Memory And Graph

Implemented temporal fields:

- `t_valid`
- `t_invalid`
- `t_created`
- `t_expired`

Memories and edges are not deleted during invalidation. They are marked expired/invalid so old facts can still be reasoned about.

Graph features:

- entity upsert
- near-duplicate entity resolution by embedding similarity
- relation writing
- edge contradiction handling
- old edge invalidation
- graph recall with recursive traversal up to 2 hops
- `asOf` retrieval filtering

Files:

- `src/graph/entities.ts`
- `src/graph/edges.ts`
- `src/graph/write.ts`
- `src/read/recall.ts`

### 16. Repo Grounding

Repo grounding is implemented through git CLI.

File:

- `src/grounding/git.ts`

Functions include:

- current repo ref
- repo name/scope derivation
- changed file listing
- latest file commit lookup

Captured episodes and memories can include:

- repo
- branch
- commit
- file/symbol anchors

### 17. Mechanical Staleness Detection

Implemented:

- `flagStaleMemories(scope)`
- compares memory anchors against latest file commit
- sets `attrs.needs_revalidation = true`
- MCP tool `memory.audit`

File:

- `src/grounding/staleness.ts`

Dashboard audit tab can show stale/invalid/archived/superseded memories.

### 18. Consolidation Loop

Implemented:

- REFLECT
- DECAY
- RE-VALIDATE

File:

- `src/consolidate/loop.ts`

Commands:

```powershell
npm run consolidate:once
npm run consolidate:loop
```

Behavior:

- REFLECT clusters recent episodes and creates durable memories.
- DECAY lowers confidence for old unused memories.
- Low-confidence memories can become archived.
- RE-VALIDATE checks stale anchored memories against current file content.

### 19. Eval Harness

Implemented:

- local eval harness
- fairer context baseline
- memory-enabled mode
- markdown results table
- latency reporting

File:

- `eval/harness.ts`

Command:

```powershell
npm run eval
```

Current status:

- Useful as smoke/regression benchmark.
- Not yet credible as public product benchmark.
- Needs larger datasets and real hosted model validation.

### 20. Dashboard

The dashboard is now more than raw tables.

URL:

```txt
http://localhost:3777/viewer
```

Implemented dashboard tabs:

- Overview
- Graph
- Memories
- Timeline
- Sessions
- Activity
- Profile
- Audit
- Lessons
- Actions
- Crystals
- Replay

Real data-backed tabs:

- Overview
- Graph
- Memories
- Timeline
- Sessions
- Activity
- Profile
- Audit

Honest placeholder tabs:

- Lessons
- Actions
- Crystals
- Replay

Dashboard backend endpoints:

- `/viewer/data/overview`
- `/viewer/data/graph`
- `/viewer/data/memories`
- `/viewer/data/episodes`
- `/viewer/data/sessions`
- `/viewer/data/activity`
- `/viewer/data/profile`
- `/viewer/data/audit`
- `/viewer/data/entities`
- `/viewer/data/edges`

Important viewer behavior:

- Hides test/demo scopes by default.
- Can show demo/test data with checkbox.
- Supports scope filtering.
- Supports search filtering.

### 21. Real Codex Scenario Test

The project was tested with a static todo app scenario in:

```txt
E:\MEMORY ENGINE TEST
```

Observed workflow:

- Codex MCP tools were visible.
- Memory was activated.
- A session id was returned.
- Codex built a simple todo app.
- Codex wrote memory tied to the activated session.
- Dashboard showed sessions/memories/episodes.

Todo app facts captured included:

- static dependency-free HTML/CSS/JS app
- `index.html`, `styles.css`, `script.js`
- add tasks
- complete tasks
- delete tasks
- filters
- clear completed
- localStorage persistence
- `node --check script.js` verification

## Tests

Current test files:

- `test/consolidate.test.ts`
- `test/embedding-provider-smoke.test.ts`
- `test/embedding-vectors.test.ts`
- `test/eval-harness.test.ts`
- `test/fuse.test.ts`
- `test/graph-recall.test.ts`
- `test/grounding.test.ts`
- `test/health.test.ts`
- `test/hook-capture.test.ts`
- `test/mcp-serialization.test.ts`
- `test/memory-activate.test.ts`
- `test/memory-ops.test.ts`
- `test/memory-routes.test.ts`
- `test/remember-route.test.ts`
- `test/retrieve.test.ts`
- `test/viewer.test.ts`

Latest known verification after dashboard work:

```txt
npm run build: passed
npm test -- --run: 34 passed, 1 skipped
npm install -g .: done
```

The skipped test is the hosted embedding provider smoke test when real API keys are not present.

## Important Recent Commits

Recent commits include:

```txt
fde50ae Build useful memory dashboard
aab1fb7 Add automatic capture smoke test command
75f8396 Capture hooks into active memory session
52b2134 Reduce viewer noise and normalize project scope
bae5f15 Serialize MCP activation dates
ee9d8c8 Require activated session for remember writes
0919a52 Fix MCP connect path outside engine repo
bb0e27c Fix global CLI project activation
57019db Add plugin-style chat sessions
e29bee6 Handle existing memoryengine server
aee6435 Add memoryengine CLI
11bc2cf Add chat memory activation
```

## What Is Built But Not Fully Proven Yet

### Real Hosted Model Behavior

Interfaces exist for:

- hosted embeddings
- hosted LLM
- Cohere reranker

But default local runs use:

- local deterministic embeddings
- local heuristic LLM behavior
- no reranker

The system is wired, but the write pipeline and semantic quality are not fully validated until real hosted models are enabled and tested.

### Public Benchmark Claim

The eval harness exists and uses a fairer baseline than the initial smoke test. However:

- dataset is still small
- public benchmark datasets are not integrated
- hosted LLM judge validation is not complete
- results should not be used as marketing headline yet

### Lessons

Dashboard tab exists as a placeholder.

There is no dedicated `lessons` table yet.

Today, lesson-like data should be stored as procedural/semantic memories.

### Actions

Dashboard tab exists as a placeholder.

There is no dedicated action extraction pipeline yet.

Future work should add:

- action table
- status field
- extraction from episodes
- pending/active/done/blocked workflow

### Crystals

Dashboard tab exists as a placeholder.

Consolidation creates durable memories, but it does not yet create named frozen session-summary artifacts.

### Replay

Dashboard tab exists as a placeholder.

Episode streams exist and can support replay later, but the dashboard does not yet have a play/pause event player.

### Graph UI

Graph data and a basic visual layout exist.

Not yet implemented:

- zoom
- drag
- recenter
- expand-neighbors
- rebuild graph button
- force-directed layout

## Known Design Decisions

### Opt-In Storage

Memory should not store every chat globally.

Final behavior:

```txt
MCP configured: tools available
chat not activated: no writes
chat activated: session exists
manual remember: requires session id
automatic hook capture: writes only if active project session exists
```

### Local First

Current system uses local PostgreSQL and local fallbacks by default.

No Docker required.

### Pgvector Optional

The project supports pgvector but can run without it.

This keeps local dev easy while allowing Neon/pgvector later.

### Graphify-Style Graph Builder Is Outsourced

The repo should not become a full use-case graph builder.

It owns:

- memory lifecycle
- repo-grounded facts
- graph persistence
- graph recall
- stale detection

It should outsource heavy Graphify-style graph building later.

## How To Run

From the engine repo:

```powershell
cd "E:\memoryengine"
npm install
npm run build
npm run db:migrate
npm install -g .
memoryengine
```

Dashboard:

```txt
http://localhost:3777/viewer
```

Doctor:

```powershell
memoryengine doctor
```

Connect Codex:

```powershell
memoryengine connect codex
```

Activate in a Codex chat:

```txt
Activate memory for this project with task "build a simple todo list web app". Search memory first. Automatic hooks can capture tool activity after activation.
```

Smoke-test automatic capture:

```powershell
memoryengine hook-test --scope "project:MEMORY ENGINE TEST"
```

## Next Best Work

Highest-value next steps:

1. Enable real hosted Gemini/OpenAI-compatible LLM and embeddings.
2. Move to Neon or local pgvector-enabled Postgres.
3. Install real Codex hooks and verify automatic capture during a longer session.
4. Improve dashboard graph interaction.
5. Add real lessons/actions/crystals tables only after the core memory loop is validated.
6. Replace smoke eval with larger LoCoMo/LongMemEval/coding-agent benchmark.
7. Add auth/hardening before any exposed deployment.

## Honest Current Status

```txt
Functional local MVP: yes
MCP-connected Codex memory: yes
Opt-in per-chat storage: yes
Automatic hook capture endpoint: yes
Useful dashboard: yes
Repo grounding: yes
Temporal memory/graph: yes
Local fallback retrieval/write pipeline: yes
Real hosted-model validation: not yet complete
Public benchmark claim: not yet credible
Production hardening: not yet complete
```

The project is no longer just a scaffold. It is a working local memory engine. The next phase should focus less on adding surface area and more on validating quality with real providers, real hooks, pgvector, and fair evaluation.
