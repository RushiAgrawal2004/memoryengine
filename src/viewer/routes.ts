import { Hono } from "hono";
import { checkDatabase } from "../db/client.js";
import {
  getViewerGraphData,
  getViewerOverview,
  getViewerProfile,
  listViewerActivity,
  listViewerAudit,
  listViewerEdges,
  listViewerEntities,
  listViewerEpisodes,
  listViewerMemories,
  listViewerSessions,
  listViewerTraces,
  ViewerListInput,
} from "../db/viewer.js";
import { config } from "../lib/config.js";

export function registerViewerRoutes(app: Hono): void {
  app.get("/viewer", (c) => c.html(viewerHtml()));

  app.get("/viewer/data/overview", async (c) => {
    return c.json({
      overview: await getViewerOverview(queryInput(c.req.query())),
      health: {
        database: await checkDatabase(),
        port: config.port,
        providers: {
          embeddings: config.embeddingsProvider,
          llm: config.llmProvider,
          rerank: config.rerankProvider,
        },
        features: {
          pgvector: "optional",
          hooks: "best-effort",
          consolidation: config.consolidateCron,
        },
      },
    });
  });

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

  app.get("/viewer/data/activity", async (c) => {
    return c.json({ rows: await listViewerActivity(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/audit", async (c) => {
    return c.json({ rows: await listViewerAudit(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/traces", async (c) => {
    return c.json({ rows: await listViewerTraces(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/profile", async (c) => {
    return c.json({ rows: await getViewerProfile(queryInput(c.req.query())) });
  });

  app.get("/viewer/data/graph", async (c) => {
    return c.json(await getViewerGraphData(queryInput(c.req.query())));
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
  <title>Memory Engine Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f6;
      --panel: #ffffff;
      --ink: #17201b;
      --muted: #637168;
      --line: #d9dfd9;
      --accent: #116b5a;
      --accent-soft: #e2f2ee;
      --warn: #9a6114;
      --danger: #9f3030;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 14px;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      padding: 18px 22px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
    .subtle { color: var(--muted); font-size: 13px; }
    main { padding: 16px 22px 28px; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(220px, 340px) auto;
      gap: 10px;
      max-width: 1220px;
      margin-bottom: 12px;
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
    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 36px;
      white-space: nowrap;
      color: var(--muted);
      font-size: 13px;
    }
    label.toggle input { width: 16px; height: 16px; padding: 0; }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 10px;
    }
    button {
      height: 33px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 10px;
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
    .status { min-height: 22px; color: var(--muted); margin: 8px 0; }
    .grid { display: grid; gap: 12px; }
    .overview-grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .two-col { grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr); align-items: start; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
    }
    .metric .label { color: var(--muted); font-size: 12px; text-transform: uppercase; font-weight: 700; }
    .metric .value { font-size: 26px; font-weight: 750; margin-top: 4px; }
    .card h2 { margin: 0 0 10px; font-size: 15px; }
    .list { display: grid; gap: 8px; }
    .item {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      background: #fbfcfb;
    }
    .item-title { font-weight: 650; margin-bottom: 4px; }
    .item-detail { color: var(--muted); line-height: 1.35; white-space: pre-wrap; }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    table { width: 100%; border-collapse: collapse; min-width: 820px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th {
      position: sticky;
      top: 0;
      background: #edf1ee;
      color: #334039;
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 700;
    }
    tr:last-child td { border-bottom: 0; }
    code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 12px; white-space: nowrap; }
    .content { max-width: 620px; white-space: pre-wrap; line-height: 1.4; }
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
    .badge.warn { color: var(--warn); border-color: #e4c995; background: #fff8eb; }
    .badge.danger { color: var(--danger); border-color: #e3aaaa; background: #fff1f1; }
    .empty {
      padding: 28px;
      color: var(--muted);
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .error { color: var(--warn); }
    .graph-panel {
      min-height: 460px;
      position: relative;
      overflow: hidden;
    }
    .graph-node {
      position: absolute;
      width: 142px;
      min-height: 46px;
      padding: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfb;
      box-shadow: 0 4px 14px rgba(23, 32, 27, 0.06);
    }
    .graph-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .graph-node span { color: var(--muted); font-size: 12px; }
    .edge-list { max-height: 460px; overflow: auto; }
    @media (max-width: 860px) {
      header { display: block; }
      .toolbar { grid-template-columns: 1fr; }
      .two-col { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Memory Engine Dashboard</h1>
      <div class="subtle">Repo-grounded memory, sessions, graph, and capture activity</div>
    </div>
    <div id="health" class="subtle">Loading health...</div>
  </header>
  <main>
    <div class="toolbar">
      <input id="search" type="search" placeholder="Search current view">
      <input id="scope" type="search" placeholder="Scope filter, e.g. project:MEMORY ENGINE TEST">
      <label class="toggle"><input id="includeInternal" type="checkbox">Show demo/test data</label>
    </div>
    <nav class="tabs" aria-label="Dashboard tabs">
      <button data-tab="overview" aria-selected="true">Overview</button>
      <button data-tab="graph" aria-selected="false">Graph</button>
      <button data-tab="memories" aria-selected="false">Memories</button>
      <button data-tab="timeline" aria-selected="false">Timeline</button>
      <button data-tab="sessions" aria-selected="false">Sessions</button>
      <button data-tab="activity" aria-selected="false">Activity</button>
      <button data-tab="profile" aria-selected="false">Profile</button>
      <button data-tab="audit" aria-selected="false">Audit</button>
      <button data-tab="traces" aria-selected="false">Traces</button>
      <button data-tab="lessons" aria-selected="false">Lessons</button>
      <button data-tab="actions" aria-selected="false">Actions</button>
      <button data-tab="crystals" aria-selected="false">Crystals</button>
      <button data-tab="replay" aria-selected="false">Replay</button>
    </nav>
    <div id="status" class="status"></div>
    <section id="content"></section>
  </main>
  <script>
    const tabs = {
      memories: {
        endpoint: "memories",
        empty: "No memories found. Activate memory in a chat and let memory.remember or hooks capture durable facts.",
        columns: ["status", "type", "content", "scope", "session", "confidence", "validity", "created"]
      },
      timeline: {
        endpoint: "episodes",
        empty: "No timeline events found. Automatic hooks and memory.remember create episode history.",
        columns: ["kind", "source", "content", "scope", "session", "occurred"]
      },
      sessions: {
        endpoint: "sessions",
        empty: "No sessions found. Use memory.activate at the start of a chat window.",
        columns: ["status", "title", "task", "agent", "scope", "memoryCount", "episodeCount", "started", "ended"]
      },
      activity: {
        endpoint: "activity",
        empty: "No activity yet.",
        columns: ["kind", "title", "detail", "scope", "session", "occurred"]
      },
      audit: {
        endpoint: "audit",
        empty: "No audit events yet. Invalidated, archived, superseded, and stale memories appear here.",
        columns: ["kind", "status", "detail", "scope", "created"]
      },
      traces: {
        endpoint: "traces",
        empty: "No traces yet. Retrieval and memory-write decisions will appear here after memory.search, activate, or remember runs.",
        columns: ["kind", "summary", "scope", "query", "latency", "payload", "created"]
      }
    };
    const placeholders = {
      lessons: {
        title: "Lessons",
        text: "Persistent learned rules are not a dedicated table yet. Today they should be stored as semantic/procedural memories and can be filtered in Memories."
      },
      actions: {
        title: "Actions",
        text: "Follow-up task extraction is not implemented yet. A future pass should add actions with pending/active/done/blocked states."
      },
      crystals: {
        title: "Crystals",
        text: "Frozen session summaries are not implemented yet. Consolidation currently creates durable memories, not named crystal artifacts."
      },
      replay: {
        title: "Replay",
        text: "Replay can be derived from Episodes, but a play/pause event player is not implemented yet. Use Timeline for the current event stream."
      }
    };
    let active = "overview";
    let timer;
    const content = document.querySelector("#content");
    const status = document.querySelector("#status");
    const health = document.querySelector("#health");
    const search = document.querySelector("#search");
    const scope = document.querySelector("#scope");
    const includeInternal = document.querySelector("#includeInternal");

    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        active = button.dataset.tab;
        document.querySelectorAll("[data-tab]").forEach((next) => {
          next.setAttribute("aria-selected", String(next === button));
        });
        load();
      });
    });
    [search, scope].forEach((input) => input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(load, 160);
    }));
    includeInternal.addEventListener("change", load);

    async function load() {
      status.textContent = "Loading...";
      try {
        if (active === "overview") {
          await renderOverview();
          return;
        }
        if (active === "graph") {
          await renderGraph();
          return;
        }
        if (active === "profile") {
          await renderProfile();
          return;
        }
        if (placeholders[active]) {
          renderPlaceholder(placeholders[active]);
          return;
        }
        await renderTableTab(active);
      } catch (error) {
        status.innerHTML = '<span class="error">Failed to load dashboard data.</span>';
        content.innerHTML = "";
      }
    }

    async function renderOverview() {
      const payload = await fetchJson("overview");
      const counts = payload.overview.counts;
      health.textContent = "DB " + (payload.health.database ? "ok" : "down") +
        " | embeddings " + payload.health.providers.embeddings +
        " | llm " + payload.health.providers.llm +
        " | rerank " + payload.health.providers.rerank;
      content.innerHTML =
        '<div class="grid overview-grid">' +
        metric("Sessions", counts.sessions, counts.activeSessions + " active") +
        metric("Memories", counts.memories, counts.activeMemories + " active") +
        metric("Episodes", counts.episodes, "captured events") +
        metric("Graph", counts.entities + " nodes", counts.edges + " edges") +
        metric("Needs Review", counts.needsRevalidation, "stale anchors") +
        metric("Invalid/Archived", counts.invalidMemories + counts.archivedMemories, "not retrieved") +
        '</div>' +
        '<div class="grid two-col" style="margin-top:12px">' +
        card("Recent Sessions", list(payload.overview.recentSessions.map(sessionItem))) +
        card("Recent Memories", list(payload.overview.recentMemories.map(memoryItem))) +
        '</div>' +
        '<div class="card" style="margin-top:12px"><h2>Project Scopes</h2>' +
        renderMiniTable(payload.overview.scopes, ["scope", "sessions", "memories", "episodes"]) +
        '</div>';
      status.textContent = "Overview loaded" + hiddenNote();
    }

    async function renderGraph() {
      const payload = await fetchJson("graph");
      const nodes = payload.nodes || [];
      const edges = payload.edges || [];
      if (nodes.length === 0 && edges.length === 0) {
        content.innerHTML = '<div class="empty">No graph data yet. Remember code facts like "auth.ts calls verifyToken" to create entities and edges.</div>';
        status.textContent = "0 graph rows" + hiddenNote();
        return;
      }
      content.innerHTML =
        '<div class="grid two-col">' +
        '<div class="card graph-panel">' + graphNodes(nodes) + '</div>' +
        '<div class="card edge-list"><h2>Edges</h2>' + list(edges.map(edgeItem)) + '</div>' +
        '</div>';
      status.textContent = nodes.length + " nodes, " + edges.length + " edges" + hiddenNote();
    }

    async function renderProfile() {
      const payload = await fetchJson("profile");
      const rows = payload.rows || [];
      if (!rows.length) {
        content.innerHTML = '<div class="empty">No project profile yet.</div>';
        status.textContent = "0 profiles" + hiddenNote();
        return;
      }
      content.innerHTML = '<div class="grid">' + rows.map((profile) =>
        '<div class="card"><h2>' + escapeHtml(profile.scope) + '</h2>' +
        '<div class="grid overview-grid">' +
        metric("Sessions", profile.sessions, "") +
        metric("Memories", profile.memories, "") +
        metric("Episodes", profile.episodes, "") +
        metric("Graph", profile.entities + " nodes", profile.edges + " edges") +
        '</div>' +
        '<div class="grid two-col" style="margin-top:12px">' +
        card("Top Entities", list((profile.topEntities || []).map(entityItem))) +
        card("Recent Memories", list((profile.recentMemories || []).map(memoryItem))) +
        '</div></div>'
      ).join("") + '</div>';
      status.textContent = rows.length + " profiles" + hiddenNote();
    }

    async function renderTableTab(tab) {
      const config = tabs[tab];
      const payload = await fetchJson(config.endpoint);
      const rows = payload.rows || [];
      if (!rows.length) {
        content.innerHTML = '<div class="empty">' + escapeHtml(config.empty) + '</div>';
      } else {
        content.innerHTML = renderTable(rows, config.columns);
      }
      status.textContent = rows.length + " rows" + hiddenNote();
    }

    function renderPlaceholder(info) {
      content.innerHTML = '<div class="empty"><strong>' + escapeHtml(info.title) + '</strong><br>' + escapeHtml(info.text) + '</div>';
      status.textContent = "Not implemented as a dedicated subsystem yet";
    }

    async function fetchJson(endpoint) {
      const params = new URLSearchParams();
      if (search.value.trim()) params.set("q", search.value.trim());
      if (scope.value.trim()) params.set("scope", scope.value.trim());
      if (includeInternal.checked) params.set("includeInternal", "1");
      const response = await fetch("/viewer/data/" + endpoint + "?" + params.toString());
      if (!response.ok) throw new Error(response.status + " " + response.statusText);
      return response.json();
    }

    function metric(label, value, hint) {
      return '<div class="card metric"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value) + '</div><div class="subtle">' + escapeHtml(hint || "") + '</div></div>';
    }
    function card(title, body) {
      return '<div class="card"><h2>' + escapeHtml(title) + '</h2>' + body + '</div>';
    }
    function list(items) {
      if (!items.length) return '<div class="empty">Nothing here yet.</div>';
      return '<div class="list">' + items.join("") + '</div>';
    }
    function memoryItem(row) {
      return '<div class="item"><div class="item-title">' + escapeHtml(row.type || row.status || "memory") + '</div><div class="item-detail">' + escapeHtml(row.content || "") + '</div><div class="subtle">' + escapeHtml(row.scope || "") + '</div></div>';
    }
    function sessionItem(row) {
      return '<div class="item"><div class="item-title">' + escapeHtml(row.title || row.task || "Untitled session") + '</div><div class="item-detail">' + escapeHtml(row.agent || "agent") + ' - ' + escapeHtml(row.status || "") + '</div><div class="subtle">' + escapeHtml(row.scope || "") + '</div></div>';
    }
    function entityItem(row) {
      return '<div class="item"><div class="item-title">' + escapeHtml(row.name || "") + '</div><div class="item-detail">' + escapeHtml(row.kind || "") + '</div></div>';
    }
    function edgeItem(row) {
      return '<div class="item"><div class="item-title">' + escapeHtml((row.source || "?") + " -> " + (row.target || "?")) + '</div><div class="item-detail">' + escapeHtml(row.relation || "") + ': ' + escapeHtml(row.fact || "") + '</div></div>';
    }
    function graphNodes(nodes) {
      return nodes.slice(0, 60).map((node, index) => {
        const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
        const ring = 140 + (index % 3) * 44;
        const x = 46 + Math.cos(angle) * ring + 210;
        const y = 46 + Math.sin(angle) * ring + 170;
        return '<div class="graph-node" style="left:' + Math.max(12, x) + 'px;top:' + Math.max(12, y) + 'px"><strong>' + escapeHtml(node.label) + '</strong><span>' + escapeHtml(node.kind) + '</span></div>';
      }).join("");
    }
    function renderMiniTable(rows, columns) {
      if (!rows.length) return '<div class="empty">No scopes found.</div>';
      return renderTable(rows, columns);
    }
    function renderTable(rows, columns) {
      return '<div class="table-wrap"><table><thead><tr>' +
        columns.map((column) => '<th>' + escapeHtml(column) + '</th>').join("") +
        '</tr></thead><tbody>' +
        rows.map((row) => '<tr>' + columns.map((column) => cell(column, row)).join("") + '</tr>').join("") +
        '</tbody></table></div>';
    }
    function cell(column, row) {
      if (column === "content" || column === "fact" || column === "detail") return '<td class="content">' + escapeHtml(row[column] || "") + '</td>';
      if (column === "validity") return '<td><code>' + escapeHtml(validity(row)) + '</code></td>';
      if (column === "created") return '<td><code>' + escapeHtml(date(row.createdAt)) + '</code></td>';
      if (column === "occurred") return '<td><code>' + escapeHtml(date(row.occurredAt)) + '</code></td>';
      if (column === "started") return '<td><code>' + escapeHtml(date(row.startedAt)) + '</code></td>';
      if (column === "ended") return '<td><code>' + escapeHtml(date(row.endedAt)) + '</code></td>';
      if (column === "session") return '<td><code>' + escapeHtml(row.sourceSession || row.sessionId || "") + '</code></td>';
      if (column === "confidence") return '<td>' + Number(row.confidence || 0).toFixed(2) + '</td>';
      if (column === "latency") return '<td>' + (row.latencyMs == null ? "" : Number(row.latencyMs).toFixed(1) + "ms") + '</td>';
      if (column === "payload") return '<td class="content"><code>' + escapeHtml(row.payload ? JSON.stringify(row.payload, null, 2) : "") + '</code></td>';
      if (column === "attrs") return '<td><code>' + escapeHtml(row.attrs ? JSON.stringify(row.attrs) : "") + '</code></td>';
      if (column === "status" || column === "type" || column === "kind" || column === "relation") {
        const cls = row[column] === "invalid" ? " danger" : row[column] === "needs_revalidation" ? " warn" : "";
        return '<td><span class="badge' + cls + '">' + escapeHtml(row[column] || "") + '</span></td>';
      }
      return '<td>' + escapeHtml(row[column] || "") + '</td>';
    }
    function validity(row) {
      const start = row.tValid || row.tCreated || row.createdAt;
      const end = row.tInvalid || row.tExpired || "open";
      return date(start) + " -> " + date(end);
    }
    function hiddenNote() {
      return includeInternal.checked ? "" : " - demo/test data hidden";
    }
    function date(value) {
      if (!value || value === "open") return "open";
      return new Date(value).toISOString().replace(".000Z", "Z");
    }
    function escapeHtml(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }
    load();
  </script>
</body>
</html>`;
}
