# Repo-Grounded Memory Engine

A persistent memory engine for coding agents, grounded in repository facts like git refs, file paths, symbols, and commit SHAs.

This project is not trying to beat general-purpose memory systems at every task. It is aiming to be the best memory engine for coding agents because repo grounding makes staleness mechanical instead of guessed.

## Quick Start

```sh
npm install
npm run dev
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

For now, embeddings are stored as JSON placeholders so the initial local database works without pgvector. The first retrieval phase uses keyword search only; pgvector can be added later when you want semantic search.

## Hybrid Retrieval

The local default uses deterministic local embeddings and no reranker, so it works without API keys:

```sh
npm run embeddings:backfill
```

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
