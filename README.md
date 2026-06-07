# Repo-Grounded Memory Engine

A persistent memory engine for coding agents, grounded in repository facts like git refs, file paths, symbols, and commit SHAs.

This project is not trying to beat general-purpose memory systems at every task. It is aiming to be the best memory engine for coding agents because repo grounding makes staleness mechanical instead of guessed.

## Quick Start

```sh
npm install
npm run dev
```

Install the local CLI:

```sh
npm run build
npm install -g .
memoryengine
memoryengine demo --reset
memoryengine connect codex
memoryengine connect git
```

This repo defaults to your local PostgreSQL service:

```sh
npm run db:local:setup
npm run db:migrate
```

The setup script uses PostgreSQL on `localhost:5432` and defaults to `postgres/postgres` for the superuser connection. Override `POSTGRES_SUPERUSER`, `POSTGRES_SUPERPASS`, or `PSQL_PATH` if your machine uses different values.

Then start the server and check:

```sh
npm run dev
curl http://localhost:3777/health
```

Save and search a memory:

```sh
curl -X POST http://localhost:3777/save -H "Content-Type: application/json" -d "{\"content\":\"we use npm for this project\",\"scope\":\"project:memory-engine\"}"
curl -X POST http://localhost:3777/search -H "Content-Type: application/json" -d "{\"query\":\"package manager\",\"scope\":\"project:memory-engine\"}"
```

Embeddings are stored as JSON vectors for local fallback and, when pgvector is available, mirrored into `embedding_vector` columns for database-side cosine recall. Hybrid retrieval combines vector recall, full-text recall, graph recall, RRF fusion, and optional reranking.

## Hybrid Retrieval

The local default uses deterministic local embeddings and no reranker, so it works without API keys:

```sh
npm run embeddings:backfill
```

On Neon or any PostgreSQL server with pgvector available, apply migrations to enable database-side vector recall:

```sh
npm run db:migrate
npm run embeddings:backfill
```

The pgvector migration is optional-safe: if the extension is unavailable, the JSON-vector fallback remains active.

To use hosted embeddings, set:

```env
EMBEDDINGS_PROVIDER=hosted
EMBEDDINGS_API_KEY=...
EMBEDDINGS_MODEL=text-embedding-3-small
EMBEDDINGS_BASE_URL=https://api.openai.com/v1
```

To use Cohere reranking, set:

```env
RERANK_PROVIDER=cohere
COHERE_API_KEY=...
RERANK_MODEL=rerank-v3.5
```

## Intelligent Writes

`memory.remember` captures an episode, extracts atomic facts, retrieves similar memories, and applies one of `ADD`, `UPDATE`, `INVALIDATE`, or `NOOP`.
For agent-facing HTTP and MCP calls, `memory.remember` requires the `sessionId`
returned by `memory.activate`, so storage is opt-in per chat window instead of
global across every chat.

The local default uses heuristic extraction and operation decisions, so it works without an API key. To use a hosted OpenAI-compatible LLM, set:

```env
LLM_PROVIDER=hosted
LLM_API_KEY=...
LLM_MODEL=gpt-4o-mini
LLM_BASE_URL=https://api.openai.com/v1
```

For Gemini's OpenAI-compatible API, use:

```env
LLM_PROVIDER=hosted
LLM_API_KEY=...
LLM_MODEL=gemini-3-flash-preview
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
```

## Knowledge Graph

`memory.remember` also extracts entities and relations into the `entities` and `edges` tables. Graph recall traverses non-expired edges up to two hops and feeds those facts into the same RRF fusion as vector and FTS recall.

Search accepts an optional `asOf` ISO timestamp to answer time-travel queries against bi-temporal memories and graph edges.

## Repo Grounding

Episodes and memories are stamped with `{ repo, branch, commit }` from the local git repo. When no scope is supplied, the engine derives `project:<repo>` automatically.

File and symbol entities become memory anchors. Symbol anchors store `{ path, symbol, startLine, endLine, symbolHash }`, so `memory.audit({ scope })` flags a memory only when the anchored symbol body changes. Anchors without a symbol fall back to file-level commit checks. Flagged memories get `attrs.needs_revalidation = true`.

## Consolidation

Run a single maintenance pass:

```sh
npm run consolidate:once
```

Run the scheduled loop:

```sh
npm run consolidate:loop
```

The schedule defaults to every 30 minutes and can be changed with `CONSOLIDATE_CRON`. Each pass logs `REFLECT`, `DECAY`, and `RE-VALIDATE` counts.

## Eval And Viewer

Run the local coding-memory benchmark:

```sh
npm run eval
```

Run a LongMemEval oracle smoke benchmark after downloading the public dataset into
`eval/datasets/longmemeval_oracle.json`:

```sh
npm run eval -- --dataset longmemeval --file eval/datasets/longmemeval_oracle.json --dataset-name longmemeval-oracle-local-50 --limit 50 --allow-local
```

`--allow-local` is intentionally explicit: it lets the harness run with local
heuristic providers for development. Remove it and configure hosted LLM/embedding
providers before treating the result as a serious product benchmark.

Generate LongMemEval-style hypotheses for the official evaluator:

```sh
npx tsx eval/longmemeval-official.ts --file eval/datasets/longmemeval_s_cleaned.json --split-name longmemeval_s --out eval/results/longmemeval-official/local-smoke --limit 10 --allow-local
```

This writes `hypotheses.jsonl` with `{ question_id, hypothesis }` lines plus
`debug.json` with retrieved memory IDs, context size, latency, hypothesis, and gold
answer. Runs with `--allow-local` are development smoke runs, not official scores.
For a real score, remove `--allow-local`, configure hosted providers, then pass the
JSONL file to LongMemEval's `evaluate_qa.py`.

Current local smoke result compares memory retrieval against a fair no-store baseline that receives the same session history as raw context:

| Mode | Items | Probes | Recall/coverage | Answer accuracy | p50 context | p95 context | p50 latency | p95 latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| context-baseline | 8 | 8 | 100% | 100% | 111 chars | 150 chars | 0ms | 0ms |
| with-memory | 8 | 8 | 100% | 100% | 109 chars | 148 chars | 2ms | 11ms |

This table proves the eval harness and memory plumbing work with a fairer baseline; it is not a public product benchmark yet. A credible benchmark still needs larger datasets such as LoCoMo or LongMemEval and real hosted model validation.

Latest LongMemEval oracle local smoke result, first 50 probes:

| Mode | Dataset | Reportable | Items | Probes | Recall@k | Evidence recall@k | Answer accuracy | p50 context | p95 context | p50 latency | p95 latency |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| context-baseline | longmemeval-oracle-local-50 | yes | 50 | 50 | 66% | 100% | 100% | 30829 chars | 55091 chars | 0ms | 0ms |
| with-memory | longmemeval-oracle-local-50 | yes | 50 | 50 | 50% | 100% | 100% | 930 chars | 1146 chars | 5ms | 14ms |

With `k=10` for the same local memory run, recall rises to 54% with p50/p95 context
of 1693/2053 chars. That is the better quality setting for multi-evidence
LongMemEval questions, while the default top-5 setting is more aggressively compact.

This LongMemEval run is useful because it proves the harness can ingest the real
benchmark shape and dramatically compress context. It is still not a public claim:
the run used deterministic local embeddings and the local heuristic judge, not real
semantic embeddings or a hosted QA judge.

Start the daemon and open `http://localhost:3777/viewer` to inspect Memories, Entities, Edges, and Episodes.

## Build Backlog

- [x] 3.0 Write AGENTS.md
- [x] 0.1 Project init + Hono + Drizzle + /health
- [x] 0.2 Full schema + migration
- [x] 0.3 MCP memory.save / memory.search (FTS only) - SHIP v0.1.0
- [x] 1.1 Embeddings provider + backfill
- [x] 1.2 Vector recall + RRF fusion
- [x] 1.3 Cohere reranker + retrieve() pipeline - SHIP v0.2.0
- [x] 2.1 LLM provider + fact extraction
- [x] 2.2 ADD/UPDATE/INVALIDATE/NOOP writer + memory.remember
- [x] 3.1 Entity extraction + resolution
- [x] 3.2 Bi-temporal edges + invalidation
- [x] 3.3 Graph-seeded recall + asOf time-travel - SHIP v0.3.0
- [x] 4.1 Capture repo refs (git grounding)
- [x] 4.2 Anchors + mechanical staleness + memory.audit
- [x] 5.0 Consolidation loop (reflect/decay/revalidate) - SHIP v0.4.0
- [x] 6.0 Claude Code + Codex hooks (auto-capture)
- [x] 7.1 Eval harness (with vs without) - SHIP v0.5.0 + benchmark
- [x] 7.2 Viewer

## Build Rules

Work one step per session, write the test with the code, and commit at every green test. Feed schema instead of prose when persistence is involved. Build the parts that make this project distinct: RRF, memory ops, bi-temporal graph behavior, repo grounding, consolidation, and evals. Keep commodity pieces behind providers so hosted APIs can become local models later. Outsource Graphify-style use-case graph building; this repo owns the repo-grounded memory layer, not a general use-case graph builder.

## Agent Setup

Build the stdio MCP server:

```sh
npm run build
```

Add this MCP server to your agent config:

```jsonc
{
  "mcpServers": {
    "memory-engine": {
      "command": "node",
      "args": ["E:/memoryengine/dist/src/index.js", "--stdio"],
      "env": {
        "DATABASE_URL": "postgres://memory_engine:memory_engine@localhost:5432/memory_engine"
      }
    }
  }
}
```

Verify `memory.activate`, `memory.search`, `memory.remember`, and `memory.audit` appear in the agent's tool list. `memory.activate` starts a saved chat session so multiple Codex/Claude sessions can be tracked under the same project scope. `memory.remember` must use that returned `session.id`; unactivated chat windows cannot write memory.

In a normal chat window, say:

```txt
Activate memory for this project with task "build a simple todo list web app". Search memory first. While building, remember durable decisions and completed changes.
```

See [docs/CHAT_ACTIVATION.md](docs/CHAT_ACTIVATION.md) for the full chat workflow.

For the real Codex todo-app integration test with Gemini, follow [docs/CODEX_REAL_SCENARIO.md](docs/CODEX_REAL_SCENARIO.md).

## Automatic Capture Hooks

Hook scripts live in `hooks/claude-code` and `hooks/codex`.

Claude Code settings example:

```jsonc
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "node E:/memoryengine/hooks/claude-code/session-start.mjs" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node E:/memoryengine/hooks/claude-code/post-tool-use.mjs" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node E:/memoryengine/hooks/claude-code/stop.mjs" }] }]
  }
}
```

Codex hook config example:

```jsonc
{
  "hooks": {
    "session-start": "node E:/memoryengine/hooks/codex/session-start.mjs",
    "post-tool-use": "node E:/memoryengine/hooks/codex/post-tool-use.mjs",
    "stop": "node E:/memoryengine/hooks/codex/stop.mjs"
  }
}
```

Set `MEMORY_ENGINE_URL=http://localhost:3777` if your daemon is not on the default URL. Capture hooks are fire-and-forget with a 1500ms abort and a 500ms escape hatch. Session-start recall uses `MEMORY_ENGINE_SEARCH_TIMEOUT_MS` and defaults to 50ms so it stays out of the prompt path.

Capture hooks post to `/hook/capture`. The server writes only when it can find an
active `memory.activate` session for the project scope; otherwise the hook returns
quietly and nothing is stored. That gives automatic capture after activation
without storing every random chat.

To smoke-test automatic capture after activating a chat session:

```sh
memoryengine hook-test --scope "project:MEMORY ENGINE TEST"
```

## Git Staleness Hook

Install a post-commit hook into the current repository:

```sh
memoryengine connect git
```

The hook posts the commit's changed files to `/hook/git/post-commit` with a short timeout. The engine derives the repo scope, runs symbol-aware staleness checks for affected anchors only, then runs RE-VALIDATE for flagged memories in that scope.
