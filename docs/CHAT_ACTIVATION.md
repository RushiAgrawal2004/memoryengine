# Chat Activation

This is the normal chat-window workflow.

Memory is opt-in per chat window. A chat does not write memories until it calls
`memory.activate`. After activation, explicit `memory.remember` calls must include
the returned `session.id`, and installed capture hooks can automatically attach
tool activity to the latest active session for the project. Other chats can search
memory, but they cannot store unless they activate their own session.

After the MCP server is connected, start a Codex or Claude chat and say:

```txt
Activate memory for this project. Use memory.activate with my current task, then keep using memory.search and memory.remember while you work.
```

For a specific app build:

```txt
Activate memory for this project with task "build a simple todo list web app". Search memory first. While building, remember durable decisions and completed changes.
```

The agent should call:

1. `memory.activate`
2. `memory.search` when it needs more context
3. `memory.remember` with the returned `session.id` after meaningful project decisions or code changes
4. `memory.audit` before relying on stale code-grounded facts

The activation response includes:

- resolved scope, usually `project:<repo>`
- saved session id for this chat window
- current repo ref when available
- relevant memories for the task
- dashboard URL
- instructions the chat agent should follow

Open the dashboard:

```txt
http://localhost:3777/viewer
```

Filter by the returned scope to see what the chat is remembering.

Use the Sessions tab to see each activated chat window. Use the returned `session.id` on later `memory.remember` calls so new memories and episodes attach to the right session.

If `/remember` or `memory.remember` is called without a `sessionId`, the engine
rejects it. That prevents accidental storage from unrelated chat windows.

Automatic capture hooks use `/hook/capture` instead. That endpoint looks up the
latest active session for the project scope and skips the event if no activated
session exists.

## MCP Config

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

With Gemini:

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
