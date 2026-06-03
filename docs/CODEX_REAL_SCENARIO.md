# Codex Real Scenario Test

This is the product test: Codex uses the memory engine while building a real simple todo app, and the dashboard shows what the memory layer captured.

## 1. Configure Gemini

Use a Gemini API key from Google AI Studio. Google documents OpenAI-compatible Gemini chat and embeddings endpoints at `https://generativelanguage.googleapis.com/v1beta/openai`.

Set `.env` like this:

```env
DATABASE_URL=postgres://memory_engine:memory_engine@localhost:5432/memory_engine
PORT=3777

EMBEDDINGS_PROVIDER=hosted
EMBEDDINGS_API_KEY=your_gemini_api_key
EMBEDDINGS_MODEL=gemini-embedding-2-preview
EMBEDDINGS_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai

LLM_PROVIDER=hosted
LLM_API_KEY=your_gemini_api_key
LLM_MODEL=gemini-2.5-flash
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai

RERANK_PROVIDER=none
```

Keep `RERANK_PROVIDER=none` for the first real test. Add Cohere later.

## 2. Prepare The Server

```powershell
cd E:\memoryengine
npm install
npm run build
npm run db:migrate
npm run scenario:todo -- --reset
```

Start the daemon if it is not already running:

```powershell
npm run dev
```

Open the dashboard:

```txt
http://localhost:3777/viewer
```

Filter by scope:

```txt
project:todo-codex-demo
```

You should see memories, episodes, and possibly graph entities/edges for the todo scenario.

## 3. Connect Codex By MCP

Build first:

```powershell
npm run build
```

Add this MCP server to Codex's MCP config:

```jsonc
{
  "mcpServers": {
    "memory-engine": {
      "command": "node",
      "args": ["E:/memoryengine/dist/src/index.js", "--stdio"],
      "env": {
        "DATABASE_URL": "postgres://memory_engine:memory_engine@localhost:5432/memory_engine",
        "EMBEDDINGS_PROVIDER": "hosted",
        "EMBEDDINGS_API_KEY": "your_gemini_api_key",
        "EMBEDDINGS_MODEL": "gemini-embedding-2-preview",
        "EMBEDDINGS_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai",
        "LLM_PROVIDER": "hosted",
        "LLM_API_KEY": "your_gemini_api_key",
        "LLM_MODEL": "gemini-2.5-flash",
        "LLM_BASE_URL": "https://generativelanguage.googleapis.com/v1beta/openai"
      }
    }
  }
}
```

Restart Codex and verify these tools appear:

- `memory.search`
- `memory.remember`
- `memory.audit`

## 4. Run The Real Codex Test

In Codex, ask:

```txt
Use memory.search with scope project:todo-codex-demo first. Then build the simple todo list web app from the remembered requirements. After each meaningful change, call memory.remember with scope project:todo-codex-demo and save what you changed.
```

Expected behavior:

- Codex searches memory before coding.
- Codex builds the todo app with add, complete, delete, filters, and localStorage.
- Codex remembers implementation decisions as it works.
- The dashboard shows new memories and episodes under `project:todo-codex-demo`.

## 5. Pass Criteria

The integration passes if:

- Codex can see the MCP tools.
- `memory.search` returns todo requirements before coding.
- Codex builds the app using those requirements.
- `memory.remember` adds new facts during/after the build.
- The dashboard shows the todo scope updating live.

If this fails, fix the first failing layer only: MCP visibility, Gemini API calls, DB writes, retrieval quality, or dashboard display.
