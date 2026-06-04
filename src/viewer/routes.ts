import { Hono } from "hono";
import {
  listViewerEdges,
  listViewerEntities,
  listViewerEpisodes,
  listViewerMemories,
  listViewerSessions,
  ViewerListInput,
} from "../db/viewer.js";

export function registerViewerRoutes(app: Hono): void {
  app.get("/viewer", (c) => c.html(viewerHtml()));

  app.get("/viewer/data/memories", async (c) => {
    return c.json({ rows: await listViewerMemories(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/sessions", async (c) => {
    return c.json({ rows: await listViewerSessions(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/entities", async (c) => {
    return c.json({ rows: await listViewerEntities(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/edges", async (c) => {
    return c.json({ rows: await listViewerEdges(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/episodes", async (c) => {
    return c.json({ rows: await listViewerEpisodes(queryInput(c.req.query())) });
  });
}

function queryInput(query: Record<string, string>): ViewerListInput {
  const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;

  return {
    q: query.q,
    scope: query.scope,
    limit,
    includeInternal: query.includeInternal === "1",
  };
}

function viewerHtml(): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Engine Viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8f6;
      --panel: #ffffff;
      --ink: #17201b;
      --muted: #627067;
      --line: #d9ded8;
      --accent: #176f5d;
      --accent-soft: #e4f3ee;
      --warn: #955f15;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    header {
      padding: 20px 24px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0;
    }
    main {
      padding: 16px 24px 28px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(160px, 280px) auto;
      gap: 10px;
      margin-bottom: 14px;
      max-width: 1160px;
      align-items: center;
    }
    input {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
      font: inherit;
      background: var(--panel);
      color: var(--ink);
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 12px;
    }
    button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      background: var(--panel);
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }
    button[aria-selected="true"] {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 650;
    }
    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 36px;
      color: var(--muted);
      white-space: nowrap;
      font-size: 13px;
    }
    label.toggle input {
      width: 16px;
      height: 16px;
      padding: 0;
    }
    .status {
      min-height: 22px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 780px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: #eef1ed;
      color: #334039;
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      white-space: nowrap;
    }
    .content {
      max-width: 560px;
      white-space: pre-wrap;
      line-height: 1.4;
    }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #f8faf8;
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }
    .empty {
      padding: 28px;
      color: var(--muted);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .error { color: var(--warn); }
    @media (max-width: 720px) {
      header, main { padding-left: 14px; padding-right: 14px; }
      .toolbar { grid-template-columns: 1fr; }
      h1 { font-size: 19px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Memory Engine Viewer</h1>
  </header>
  <main>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search current tab">
      <input id="scope" type="search" placeholder="Scope filter, e.g. project:MEMORY ENGINE TEST">
      <label class="toggle"><input id="includeInternal" type="checkbox">Show demo/test data</label>
    </div>
    <nav class="tabs" aria-label="Viewer tabs">
      <button data-tab="memories" aria-selected="true">Memories</button>
      <button data-tab="sessions" aria-selected="false">Sessions</button>
      <button data-tab="entities" aria-selected="false">Entities</button>
      <button data-tab="edges" aria-selected="false">Edges</button>
      <button data-tab="episodes" aria-selected="false">Episodes</button>
    </nav>
    <div id="status" class="status"></div>
    <section id="content"></section>
  </main>
  <script>
    const tabs = {
      memories: {
        empty: "No memories found. Use memory.remember or POST /remember to populate this scope.",
        columns: ["status", "type", "content", "scope", "session", "confidence", "validity", "created"]
      },
      sessions: {
        empty: "No sessions found. Use memory.activate at the start of a chat window.",
        columns: ["status", "title", "task", "agent", "scope", "memoryCount", "episodeCount", "started", "ended"]
      },
      entities: {
        empty: "No entities found. Remember code facts with files, symbols, or dependencies to build the graph.",
        columns: ["kind", "name", "scope", "attrs", "created"]
      },
      edges: {
        empty: "No edges found. Relations such as calls and depends on appear here after ingestion.",
        columns: ["relation", "source", "target", "fact", "scope", "validity"]
      },
      episodes: {
        empty: "No episodes found. Capture hooks and memory.remember create episode history.",
        columns: ["kind", "source", "content", "scope", "session", "occurred"]
      }
    };
    let active = "memories";
    let timer;
    const content = document.querySelector("#content");
    const status = document.querySelector("#status");
    const search = document.querySelector("#search");
    const scope = document.querySelector("#scope");
    const includeInternal = document.querySelector("#includeInternal");

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        active = button.dataset.tab;
        document.querySelectorAll("[data-tab]").forEach((next) => {
          next.setAttribute("aria-selected", String(next === button));
        });
        loadRows();
      });
    });
    [search, scope].forEach((input) => input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(loadRows, 160);
    }));
    includeInternal.addEventListener("change", loadRows);

    async function loadRows() {
      status.textContent = "Loading...";
      const params = new URLSearchParams();
      if (search.value.trim()) params.set("q", search.value.trim());
      if (scope.value.trim()) params.set("scope", scope.value.trim());
      if (includeInternal.checked) params.set("includeInternal", "1");
      try {
        const response = await fetch("/viewer/data/" + active + "?" + params.toString());
        if (!response.ok) throw new Error(response.status + " " + response.statusText);
        const payload = await response.json();
        renderRows(payload.rows || []);
        status.textContent = (payload.rows || []).length + " rows" +
          (includeInternal.checked ? "" : " · demo/test data hidden");
      } catch (error) {
        status.innerHTML = '<span class="error">Failed to load viewer data.</span>';
        content.innerHTML = "";
      }
    }

    function renderRows(rows) {
      if (rows.length === 0) {
        content.innerHTML = '<div class="empty">' + escapeHtml(tabs[active].empty) + '</div>';
        return;
      }
      const columns = tabs[active].columns;
      content.innerHTML = '<div class="table-wrap"><table><thead><tr>' +
        columns.map((column) => '<th>' + escapeHtml(column) + '</th>').join("") +
        '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + columns.map((column) => cell(column, row)).join("") + '</tr>').join("") +
        '</tbody></table></div>';
    }

    function cell(column, row) {
      if (column === "content" || column === "fact") return '<td class="content">' + escapeHtml(row[column] || "") + '</td>';
      if (column === "validity") return '<td><code>' + escapeHtml(validity(row)) + '</code></td>';
      if (column === "created") return '<td><code>' + escapeHtml(date(row.createdAt)) + '</code></td>';
      if (column === "occurred") return '<td><code>' + escapeHtml(date(row.occurredAt)) + '</code></td>';
      if (column === "started") return '<td><code>' + escapeHtml(date(row.startedAt)) + '</code></td>';
      if (column === "ended") return '<td><code>' + escapeHtml(date(row.endedAt)) + '</code></td>';
      if (column === "session") return '<td><code>' + escapeHtml(row.sourceSession || row.sessionId || "") + '</code></td>';
      if (column === "confidence") return '<td>' + Number(row.confidence || 0).toFixed(2) + '</td>';
      if (column === "attrs") return '<td><code>' + escapeHtml(row.attrs ? JSON.stringify(row.attrs) : "") + '</code></td>';
      if (column === "status" || column === "type" || column === "kind" || column === "relation") {
        return '<td><span class="badge">' + escapeHtml(row[column] || "") + '</span></td>';
      }
      return '<td>' + escapeHtml(row[column] || "") + '</td>';
    }

    function validity(row) {
      const start = row.tValid || row.tCreated || row.createdAt;
      const end = row.tInvalid || row.tExpired || "open";
      return date(start) + " -> " + date(end);
    }
    function date(value) {
      if (!value || value === "open") return "open";
      return new Date(value).toISOString().replace(".000Z", "Z");
    }
    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
    loadRows();
  </script>
</body>
</html>`;
}
