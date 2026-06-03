# Repo-Grounded Memory Engine

Purpose: build a persistent memory engine for coding agents that grounds every memory in repository facts such as git refs, file paths, symbols, and commit SHAs.

Tech stack:
- Node 20+ and TypeScript
- Hono for the HTTP daemon
- Drizzle ORM for persistence
- PostgreSQL with pgvector for relational, lexical, vector, and graph indexes
- `@modelcontextprotocol/sdk` for MCP tools
- Vitest for tests

Rules:
- Work one step per session: implement only the pasted step, write its Vitest in the same session, run the acceptance test, then commit on green.
- All persistence goes through modules in `src/db`; do not scatter ad-hoc SQL strings across feature files.
- Feature modules may call repository/query helpers, but they should not create their own database clients.
- Providers for embeddings, LLMs, and reranking must be accessed through interfaces in `src/providers`; never call external APIs directly from feature code.
- Keep repo grounding explicit: memories that come from code should carry scope, repo refs, anchors, and provenance whenever available.
- Every new module ships with a focused Vitest test file unless it is only a thin entrypoint.
- Prefer concrete schema and DDL over prose when changing persistence-heavy behavior.
- Commit at every green test so memory regressions have clean bisect points.
- Build the differentiating pieces here: schema, RRF, memory ops, bi-temporal graph logic, repo grounding, consolidation, and evals. Outsource commodity model calls through providers.
- Outsource Graphify-style use-case graph building; keep this repo focused on repo-grounded memory, graph persistence, retrieval, and validation.
- Do not add new infrastructure casually: Postgres plus provider APIs should cover vector, graph, embeddings, reranking, jobs, and MCP until the design proves it needs more.

Commands:
- Build: `npm run build`
- Test: `npm test`
- Run locally: `npm run dev`
- Apply schema: `npm run db:migrate`
