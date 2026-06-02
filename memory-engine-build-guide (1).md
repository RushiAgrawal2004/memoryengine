# Build Guide: A Repo-Grounded Memory Engine for Coding Agents

A step-by-step, vibe-code-with-Codex guide to building a persistent memory engine that beats general-purpose engines **for coding agents specifically** — by grounding every memory in the actual repository.

> **Positioning (keep this in your README).** You are not trying to beat Zep at enterprise temporal reasoning or Mem0 at minimal latency. You are building the best memory engine *for coding agents*, because you are the only one anchored to git refs, file paths, and commit SHAs — which makes staleness mechanical instead of guessed. That is a winnable, defensible claim.

---

## 0. How to use this document

- Every **Step** is scoped to roughly one Codex session.
- Each step has: **Goal → Outsource → Build → Codex prompt → Acceptance test.**
- Do the steps **in order**. Each one leaves you with something that runs. Never start Phase N+1 until Phase N's acceptance test passes.
- The `Codex prompt` blocks are written to paste straight in. Edit paths/names to match your repo.
- Ship Phase 0 publicly the day it works. Stars accrue to running repos.

---

## 1. The stack (and what we outsource)

The guiding rule: **build the parts that are your moat, outsource everything generic.**

| Concern | Choice | Build or outsource | Why |
|---|---|---|---|
| Language / runtime | TypeScript, Node 20+ | — | Codex is strongest here; MCP SDK is TS-first |
| Database | PostgreSQL | **Outsource hosting** (Neon or Supabase free tier) | One engine holds all four indexes |
| Vectors | `pgvector` extension | Outsource (built into Neon/Supabase) | No separate vector DB to operate |
| Lexical search | Postgres `tsvector` FTS | — (built in) | BM25-ish keyword recall for free |
| Graph | Relational `entities` + `edges` tables + recursive CTEs | **Build (lightweight)** | Avoids running Neo4j; multi-hop via SQL |
| ORM / queries | Drizzle ORM + raw SQL where needed | Outsource | TS-native, Codex handles it well, easy raw SQL escape hatch |
| Embeddings | Hosted embedding API, pluggable | **Outsource** (swappable to local later) | Speed now; `transformers.js` local option later |
| Extraction / memory-ops / reflection LLM | A small, fast, cheap model via API | **Outsource** | These are LLM-judgement calls, not your moat |
| Reranker | Cohere Rerank (or Voyage); local `bge-reranker` as no-API fallback | **Outsource** | Cross-encoders are a solved commodity |
| Rank fusion (RRF) | ~25 lines you write | **Build** | Trivial, no dependency worth it |
| MCP server | `@modelcontextprotocol/sdk` | **Outsource** | Never hand-roll the protocol |
| HTTP daemon | Hono (or Fastify) | Outsource | Light, fast, TS-first |
| Scheduler (consolidation) | `node-cron` to start; `pg_cron` later | Outsource | Don't build a job queue yet |
| Eval datasets | LongMemEval + LoCoMo (public) | **Outsource** | Reuse established benchmarks; add a coding one |
| Viewer UI | Next.js or plain Hono + HTML | Build (last) | Small; do it after the engine works |

**Accounts to create before you start:** a Postgres host (Neon), an embeddings + LLM API key (whatever provider you already pay for), and a Cohere key (rerank). All have free tiers big enough for development.

---

## 2. Repository layout

```
memory-engine/
├─ AGENTS.md                 # instructions Codex reads on every session (see §3)
├─ README.md
├─ .env.example
├─ package.json
├─ drizzle.config.ts
├─ src/
│  ├─ index.ts               # daemon entrypoint (Hono server + MCP)
│  ├─ db/
│  │  ├─ schema.ts           # Drizzle schema (the four indexes)
│  │  └─ client.ts           # pooled pg connection
│  ├─ providers/
│  │  ├─ embeddings.ts       # interface + hosted impl + local impl
│  │  ├─ llm.ts              # interface + chat/json-mode impl
│  │  └─ rerank.ts           # interface + Cohere impl + local fallback
│  ├─ write/
│  │  ├─ capture.ts          # episode ingestion
│  │  ├─ extract.ts          # facts + entities + relations + temporal refs
│  │  └─ memory-ops.ts       # ADD / UPDATE / INVALIDATE / NOOP decision
│  ├─ read/
│  │  ├─ recall.ts           # parallel vector + FTS + graph recall
│  │  ├─ fuse.ts             # reciprocal rank fusion
│  │  └─ retrieve.ts         # decompose → recall → fuse → rerank → pack
│  ├─ graph/
│  │  ├─ entities.ts         # upsert + resolve entities
│  │  └─ edges.ts            # bi-temporal edge write + invalidation
│  ├─ grounding/
│  │  └─ git.ts              # repo refs, anchors, staleness detection
│  ├─ consolidate/
│  │  └─ loop.ts             # reflect · decay · re-validate
│  ├─ mcp/
│  │  └─ server.ts           # MCP tool definitions + handlers
│  └─ lib/
│     ├─ config.ts           # env-driven config
│     └─ scope.ts            # scope helpers (global / project / session)
├─ hooks/
│  ├─ claude-code/           # hook scripts
│  └─ codex/
├─ eval/
│  ├─ harness.ts
│  └─ datasets/
└─ test/
```

---

## 3. Set Codex up to succeed (do this first)

Codex (and Claude Code) read an `AGENTS.md` at the repo root automatically. A good one is the single highest-leverage thing for vibe-coding quality. Create it before any code.

**Codex prompt:**
```
Create an AGENTS.md at the repo root for a TypeScript memory-engine project.
Include: the project's one-line purpose; the tech stack (Node 20+, Hono, Drizzle,
Postgres + pgvector, MCP SDK); the rule that ALL persistence goes through Drizzle
in src/db and never via ad-hoc SQL strings scattered in feature files; the rule
that providers (embeddings, llm, rerank) are always accessed through their
interface in src/providers and never called directly; the build command, the
test command (vitest), and that every new module ships with a vitest test file.
Keep it under 400 words.
```

**Why:** every later Codex session inherits these constraints, so you stop re-explaining architecture and Codex stops scattering raw SQL everywhere.

---

## 4. Phase 0 — Skeleton that runs end-to-end

**Outcome of this phase:** a daemon with two working MCP tools (`memory.save`, `memory.search`) backed by Postgres, using keyword search only. You can connect it to Codex/Claude Code and watch a memory round-trip. No embeddings, no graph yet.

### Step 0.1 — Project init + DB connection

- **Goal:** `npm run dev` starts a Hono server; `/health` returns DB connectivity.
- **Outsource:** create a Neon project, copy the connection string into `.env`.
- **Build:** `package.json`, `tsconfig`, Hono server, pooled `pg` client, Drizzle config.

**Codex prompt:**
```
Initialize a TypeScript Node 20 project with: Hono HTTP server on PORT (default
3777), Drizzle ORM wired to a Postgres DATABASE_URL from .env via the `postgres`
driver, and a GET /health route that runs `select 1` and returns { ok, db }.
Add scripts: dev (tsx watch src/index.ts), build (tsc), test (vitest).
Create .env.example with DATABASE_URL, PORT.
```

- **Acceptance test:** `curl localhost:3777/health` returns `{ ok: true, db: true }`.

### Step 0.2 — The schema (all four indexes, used incrementally)

- **Goal:** the full schema exists now even though early phases only use part of it. Migrating later is more painful than unused columns.
- **Outsource:** `CREATE EXTENSION vector;` (Neon supports it).
- **Build:** Drizzle schema mirroring the SQL below.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- (1) EPISODIC LOG — raw, non-lossy event stream
CREATE TABLE episodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL,                 -- global | project:<repo> | session:<id>
  kind          text NOT NULL,                 -- tool_use | message | observation | decision
  content       text NOT NULL,
  source        text NOT NULL,                 -- hook | explicit_mcp | watcher
  repo_ref      jsonb,                         -- { repo, commit, branch }
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- (2) SEMANTIC / PROCEDURAL MEMORIES — distilled, retrievable
CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,                 -- episodic_summary | semantic | procedural
  scope         text NOT NULL,
  content       text NOT NULL,
  embedding     vector(1536),
  fts           tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  confidence    real NOT NULL DEFAULT 0.5,
  status        text NOT NULL DEFAULT 'active',-- active | invalid
  -- bi-temporal
  t_valid       timestamptz,                   -- true-in-world from
  t_invalid     timestamptz,                   -- true-in-world until
  t_created     timestamptz NOT NULL DEFAULT now(), -- learned at
  t_expired     timestamptz,                   -- invalidated-in-system at
  -- provenance + grounding (the moat)
  source_episode uuid REFERENCES episodes(id),
  repo_ref      jsonb,
  anchors       jsonb,                         -- [{ path, symbol, commit }]
  supersedes    uuid REFERENCES memories(id),
  use_count     int NOT NULL DEFAULT 0,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- (3) GRAPH ENTITIES — files, symbols, errors, dependencies, decisions
CREATE TABLE entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL,
  kind          text NOT NULL,                 -- file | symbol | error | dependency | decision | concept
  name          text NOT NULL,
  embedding     vector(1536),
  attrs         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, kind, name)
);

-- (4) GRAPH EDGES — bi-temporal relationships (Zep-style four timestamps)
CREATE TABLE edges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL,
  src           uuid REFERENCES entities(id),
  dst           uuid REFERENCES entities(id),
  relation      text NOT NULL,                 -- calls | depends_on | caused_by | supersedes | relates_to
  fact          text,                          -- NL statement of the edge
  embedding     vector(1536),
  t_valid       timestamptz,
  t_invalid     timestamptz,
  t_created     timestamptz NOT NULL DEFAULT now(),
  t_expired     timestamptz,
  source_episode uuid REFERENCES episodes(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- indexes
CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON memories USING gin (fts);
CREATE INDEX ON memories (scope, status);
CREATE INDEX ON entities USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON edges USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON edges (scope, relation) WHERE t_expired IS NULL;
```

**Codex prompt:**
```
Translate the SQL schema in docs into a Drizzle schema at src/db/schema.ts using
drizzle-orm/pg-core. Use the `vector` type from drizzle's pgvector support for
embedding columns (dimension 1536). Generate the initial migration with
drizzle-kit and add a `db:migrate` script. The fts column is a generated column —
declare it as such so Drizzle doesn't try to write it.
```

- **Acceptance test:** `npm run db:migrate` succeeds; `\d memories` in psql shows all columns and indexes.

### Step 0.3 — `memory.save` and `memory.search` over MCP (keyword only)

- **Goal:** two MCP tools that write a memory and search it by Postgres FTS.
- **Outsource:** `@modelcontextprotocol/sdk` for the protocol.
- **Build:** `src/mcp/server.ts` with the two tools; `save` inserts into `memories` (embedding null for now), `search` runs a `ts_rank` query filtered by scope.

**Codex prompt:**
```
Using @modelcontextprotocol/sdk, create an MCP server in src/mcp/server.ts exposing
two tools:
- memory.save({ content, type?, scope? }) -> inserts a row into memories (embedding
  left null for now) and returns the id.
- memory.search({ query, scope?, limit? }) -> runs a Postgres full-text query
  (websearch_to_tsquery against the fts column), ranks with ts_rank, filters by
  scope and status='active', returns the top `limit` (default 5) rows.
Mount the MCP server over stdio AND expose the same two operations as POST routes
on the Hono daemon (/save, /search) so I can curl them. Add a vitest test that
saves three memories and asserts search returns the relevant one first.
```

- **Acceptance test:** the vitest passes; connect the server to Codex (see §11) and confirm the agent can call both tools.

**🎉 Ship this.** Tag `v0.1.0`, push, write a 5-line README. You now have a working memory MCP server. Everything below makes it *smart*.

---

## 5. Phase 1 — Hybrid retrieval (vector + lexical + rerank)

**Outcome:** search quality jumps from keyword-matching to semantic. You add embeddings, fuse vector + FTS results with RRF, then rerank.

### Step 1.1 — Embedding provider (pluggable)

- **Outsource:** hosted embedding API.
- **Build:** an `Embeddings` interface (`embed(texts: string[]): Promise<number[][]>`) with a hosted implementation now and a stub for a local `transformers.js` implementation later. Backfill embeddings on `memory.save`.

**Codex prompt:**
```
Create src/providers/embeddings.ts exporting an Embeddings interface with
embed(texts: string[]): Promise<number[][]>. Implement HostedEmbeddings reading
EMBEDDINGS_API_KEY, EMBEDDINGS_MODEL, EMBEDDINGS_BASE_URL from config, batching
up to 100 texts per call. Add a factory getEmbeddings() selecting impl by
EMBEDDINGS_PROVIDER env (default "hosted"). Update memory.save to embed content
and store the vector. Add a backfill script src/scripts/backfill-embeddings.ts.
```

### Step 1.2 — Vector recall + RRF fusion

- **Build (don't outsource):** RRF is ~25 lines.

**Codex prompt:**
```
In src/read/recall.ts add vectorRecall(query, scope, k) that embeds the query and
runs an ORDER BY embedding <=> $vector cosine query (status='active'), and keep
the existing ftsRecall. In src/read/fuse.ts implement reciprocal rank fusion:
rrf(lists, k=60) merging multiple ranked lists by sum of 1/(k + rank). Add a
vitest proving a doc ranked high in either list surfaces in the fused result.
```

### Step 1.3 — Reranker

- **Outsource:** Cohere Rerank (`rerank` endpoint). Add a local `bge-reranker` fallback later.

**Codex prompt:**
```
Create src/providers/rerank.ts with a Reranker interface
rerank(query, docs, topN): Promise<{ index, score }[]> and a CohereReranker impl
reading COHERE_API_KEY and RERANK_MODEL. Wire src/read/retrieve.ts as:
embed query -> vectorRecall(30) + ftsRecall(30) -> rrf -> take top 20 ->
rerank -> return topN (default 5). Update memory.search to use retrieve().
```

- **Acceptance test:** with ~30 seeded memories, a paraphrased query (no shared keywords) returns the semantically correct memory in the top 3.

---

## 6. Phase 2 — Intelligent write pipeline (Mem0-style)

**Outcome:** writes stop being dumb appends. New facts are checked against existing memory and the system decides ADD / UPDATE / INVALIDATE / NOOP. This is what kills memory rot.

### Step 2.1 — LLM provider + fact extraction

- **Outsource:** small fast model via API, JSON mode.

**Codex prompt:**
```
Create src/providers/llm.ts with an LLM interface: json<T>(system, user, schema)
returning parsed JSON validated by a zod schema, and chat(system, user) for text.
Implement against LLM_API_KEY / LLM_MODEL / LLM_BASE_URL. Then src/write/extract.ts:
extractFacts(episodeText) -> array of atomic, self-contained fact strings plus any
temporal references ("two weeks ago" -> resolved ISO date using the episode's
occurred_at as reference). Validate output with zod.
```

### Step 2.2 — The memory-ops decision

- **Build:** the core writer. For each extracted fact: retrieve similar existing memories, ask the LLM to choose an op, apply it with bi-temporal bookkeeping.

```
ADD        -> insert new memory
UPDATE     -> edit content, bump confidence, set last_used_at
INVALIDATE -> set status='invalid', t_invalid=now (world), t_expired=now (system);
              insert the new memory with supersedes = old.id
NOOP       -> do nothing
```

**Codex prompt:**
```
Implement src/write/memory-ops.ts: ingestFacts(facts, ctx). For each fact: run
retrieve() to get the 5 most similar active memories, then call llm.json with a
prompt that returns { op: 'ADD'|'UPDATE'|'INVALIDATE'|'NOOP', targetId?, content }.
Apply ops in a single transaction with the bi-temporal rules described in docs
(INVALIDATE sets status, t_invalid, t_expired on the old row and inserts a new row
with supersedes pointing at it). Add an MCP tool memory.remember({ text, scope })
that runs capture -> extract -> ingestFacts. Add vitest covering each of the four ops.
```

- **Acceptance test:** save "we use npm", then save "we switched to pnpm" — assert the npm memory is now `invalid` and the pnpm memory `supersedes` it.

---

## 7. Phase 3 — Bi-temporal knowledge graph

**Outcome:** memories gain structure. Entities (files, symbols, errors, decisions) and bi-temporal edges let you answer relational and time-travel queries, and enable graph-seeded recall.

### Step 3.1 — Entity extraction + resolution

**Codex prompt:**
```
Extend src/write/extract.ts to also return entities [{ kind, name }] and relations
[{ srcName, relation, dstName, fact, tValid? }]. In src/graph/entities.ts implement
upsertEntity(scope, kind, name, attrs) that resolves duplicates by (scope, kind,
name) and by embedding similarity above a threshold (link near-duplicate names to
the existing entity). Embed entity names on insert.
```

### Step 3.2 — Bi-temporal edges + invalidation

**Codex prompt:**
```
In src/graph/edges.ts implement writeEdge(relation) that, before inserting, searches
existing non-expired edges between the same entities and uses llm.json to decide if
the new edge CONTRADICTS an existing one. If so, set t_invalid and t_expired on the
old edge (don't delete) and insert the new edge. Store fact text and its embedding.
Wire entity + edge writing into ingestFacts so a single remember() call updates both
the memories table and the graph.
```

### Step 3.3 — Graph-seeded recall

**Codex prompt:**
```
Add graphRecall(query, scope, k) in src/read/recall.ts: extract entity names from
the query, find matching entities, then a recursive CTE traversing up to 2 hops over
non-expired edges, returning the connected facts. Add this as a third list into the
RRF fusion in retrieve(). Add a time-travel option: retrieve({ asOf }) filters edges/
memories to those valid at the given timestamp (t_valid <= asOf AND (t_invalid IS
NULL OR t_invalid > asOf)).
```

- **Acceptance test:** after ingesting "auth.ts calls verifyToken" and "verifyToken depends on jwtlib", a 2-hop query from `auth.ts` surfaces `jwtlib`. An `asOf` query before an invalidation returns the old fact.

---

## 8. Phase 4 — Repo grounding (your moat)

**Outcome:** memories are anchored to the codebase, so staleness is detected mechanically. No general engine can do this.

### Step 4.1 — Capture repo refs

**Codex prompt:**
```
Create src/grounding/git.ts with currentRepoRef(cwd) returning { repo, branch,
commit } via `git` CLI (spawned, no native dep) and listChangedFiles(sinceCommit).
Stamp repo_ref on every episode and memory at capture time. Derive scope
"project:<repo>" automatically from the repo name when not explicitly passed.
```

### Step 4.2 — Anchors + mechanical staleness

**Codex prompt:**
```
When extracting entities of kind 'file' or 'symbol', attach anchors [{ path, symbol,
commit }] to the resulting memory. Add a function flagStaleMemories(scope): compare
each memory's anchored file commit against the file's latest commit; if the file
changed since the anchor, set a needs_revalidation flag in attrs. Expose an MCP tool
memory.audit({ scope }) returning counts of active / invalid / needs_revalidation.
```

- **Acceptance test:** anchor a memory to a file, commit a change to that file, run the staleness check, confirm the memory is flagged `needs_revalidation`.

---

## 9. Phase 5 — Consolidation loop (reflect · decay · re-validate)

**Outcome:** the store maintains itself — the thing almost no shipping engine does well.

**Codex prompt:**
```
Create src/consolidate/loop.ts run on a node-cron schedule (CONSOLIDATE_CRON,
default every 30 min) with three passes, each idempotent and logged:
1) REFLECT: cluster recent episodes (last N) by embedding; for each cluster,
   llm summarize into 0-3 durable semantic/procedural memories via ingestFacts.
2) DECAY: lower confidence of memories not used in DECAY_DAYS; demote below a floor
   to status='archived' (new status, excluded from retrieval).
3) RE-VALIDATE: for memories flagged needs_revalidation, re-check the anchored fact
   against current file content via llm; UPDATE or INVALIDATE accordingly.
Add a CLI `consolidate:once` to run a single pass for testing. Cover each pass with a
vitest using a fake clock.
```

- **Acceptance test:** seed 20 related episodes, run `consolidate:once`, confirm a small number of higher-level semantic memories were created and raw episodes were not destroyed.

---

## 10. Phase 6 — Automatic capture via hooks

**Outcome:** memory forms with zero user effort, from both Claude Code and Codex.

**Codex prompt:**
```
Create hook scripts under hooks/. For Claude Code: a session-start hook that calls
memory.search with the current task and prints results, and post-tool-use / stop
hooks that POST tool I/O to /save as episodes (fire-and-forget: unawaited fetch with
AbortSignal.timeout(1500) and a setTimeout(()=>process.exit(0),500).unref() so hooks
never block the agent). Provide the equivalent for Codex's hook mechanism. Document
the one-line install in README (writing the hook config into the agent's settings).
```

- **Acceptance test:** run a real coding task in Codex; confirm episodes appear in the DB and a follow-up session retrieves a relevant memory unprompted.

> **Latency rule:** capture hooks must be fire-and-forget. Retrieval hooks sit in the prompt path — keep them under ~50ms or make them async and best-effort. If memory makes the agent feel slow, users disable it.

---

## 11. Connecting it to Codex / Claude Code

For an stdio MCP server, add it to the agent's MCP config (paths are illustrative):

```jsonc
{
  "mcpServers": {
    "memory-engine": {
      "command": "node",
      "args": ["/abs/path/memory-engine/dist/index.js", "--stdio"],
      "env": { "DATABASE_URL": "..." }
    }
  }
}
```

Verify the tools (`memory.search`, `memory.remember`, `memory.audit`) appear in the agent's tool list, then ask it to remember and recall something.

---

## 12. Phase 7 — Prove it's better (eval) + viewer

This is the phase that converts "I think it's good" into a benchmark number you put in the README headline. **Do not skip it** — it's your strongest marketing and your regression guard.

### Step 7.1 — Eval harness

- **Outsource the datasets:** LongMemEval and LoCoMo are public, multi-session memory benchmarks. Add your own small **coding** benchmark (multi-session tasks where session 2 needs a fact from session 1).

**Codex prompt:**
```
Build eval/harness.ts that, for each benchmark item: resets a scratch scope, ingests
the item's session history through the real write pipeline, then for each probe
question runs retrieve() and scores answer correctness with an LLM judge. Report
recall@k, answer accuracy, and p50/p95 retrieval latency. Add a baseline mode that
disables memory so I can report WITH vs WITHOUT. Output a markdown results table.
```

### Step 7.2 — Viewer (last)

**Codex prompt:**
```
Add a minimal viewer (Hono routes + a single HTML page, no framework) with tabs for
Memories, Entities, Edges (showing validity intervals), and Episodes; each tab has
empty-state help text and a search box hitting the existing endpoints.
```

- **Acceptance test:** the harness prints a table showing measurably higher accuracy with memory enabled than without. That table is your README's hero.

---

## 13. Vibe-coding with Codex: working rules

1. **One step per session.** Paste the step's prompt, let Codex implement just that, run the acceptance test, commit. Long multi-step prompts produce tangled diffs.
2. **Make Codex write the test in the same session as the code.** "Add a vitest that…" is in every prompt above for a reason.
3. **Keep `AGENTS.md` current.** When a convention emerges (error handling, transaction style), add one line. It compounds.
4. **Feed the schema, not prose, when in doubt.** Paste the relevant table from §4 into the session — Codex grounds far better on the concrete DDL.
5. **Commit at every green test.** Memory bugs are subtle; you want clean bisect points.
6. **Resist building the graph in Phase 0.** The single most common way this project dies is building all six layers before any of them runs. The phase order is the product.

---

## 14. Copy-paste backlog (the whole build, in order)

```
[ ] 3.0  Write AGENTS.md
[ ] 0.1  Project init + Hono + Drizzle + /health
[ ] 0.2  Full schema + migration
[ ] 0.3  MCP memory.save / memory.search (FTS only)  ── SHIP v0.1.0
[ ] 1.1  Embeddings provider + backfill
[ ] 1.2  Vector recall + RRF fusion
[ ] 1.3  Cohere reranker + retrieve() pipeline       ── SHIP v0.2.0
[ ] 2.1  LLM provider + fact extraction
[ ] 2.2  ADD/UPDATE/INVALIDATE/NOOP writer + memory.remember
[ ] 3.1  Entity extraction + resolution
[ ] 3.2  Bi-temporal edges + invalidation
[ ] 3.3  Graph-seeded recall + asOf time-travel       ── SHIP v0.3.0
[ ] 4.1  Capture repo refs (git grounding)
[ ] 4.2  Anchors + mechanical staleness + memory.audit
[ ] 5.0  Consolidation loop (reflect/decay/revalidate)── SHIP v0.4.0
[ ] 6.0  Claude Code + Codex hooks (auto-capture)
[ ] 7.1  Eval harness (with vs without)               ── SHIP v0.5.0 + benchmark
[ ] 7.2  Viewer
```

---

## 15. Outsourcing cheat-sheet

- **Don't run:** a vector DB, a graph DB, an embedding model, a reranker, a job queue, the MCP protocol. Postgres + APIs cover all of it.
- **Do build:** the schema, RRF, the memory-ops decision, the bi-temporal edge logic, repo grounding, the consolidation passes, the eval harness. These are your moat and your differentiation.
- **Swap to local later (optional):** `transformers.js` embeddings + `bge-reranker` + a small local model remove all API dependencies for a "100% local, private" selling point — but only after the hosted version proves the design works.

---

*Build the parts that are yours. Outsource the rest. Ship at every green test. Prove "better" with the eval table — never just claim it.*
