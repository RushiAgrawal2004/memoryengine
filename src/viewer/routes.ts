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
      --bg: #fff7df;
      --bg-grid: rgba(18, 18, 18, 0.055);
      --paper: #fffdf2;
      --paper-2: #fff1b8;
      --ink: #121212;
      --muted: #5f574d;
      --line: #121212;
      --teal: #5eead4;
      --green: #9af277;
      --pink: #ff7ab6;
      --blue: #75b8ff;
      --orange: #ffb454;
      --red: #ff6b5f;
      --shadow: 5px 5px 0 #121212;
      --shadow-sm: 3px 3px 0 #121212;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px) 0 0 / 26px 26px,
        linear-gradient(var(--bg-grid) 1px, transparent 1px) 0 0 / 26px 26px,
        var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 15px;
      letter-spacing: 0;
    }
    .shell {
      width: min(1560px, calc(100% - 36px));
      margin: 18px auto 36px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 22px;
      align-items: stretch;
      padding: 22px;
      border: 3px solid var(--line);
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    .brand {
      display: flex;
      gap: 16px;
      align-items: center;
      min-width: 0;
    }
    .logo {
      width: 58px;
      height: 58px;
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      border: 3px solid var(--line);
      background: var(--teal);
      box-shadow: var(--shadow-sm);
      font-size: 30px;
      font-weight: 950;
    }
    h1 {
      margin: 0;
      font-size: clamp(30px, 4vw, 54px);
      line-height: 0.92;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .tagline {
      margin-top: 10px;
      color: var(--muted);
      font-weight: 700;
    }
    .hero-side {
      min-width: 270px;
      border: 3px solid var(--line);
      background: var(--green);
      padding: 14px;
      box-shadow: var(--shadow-sm);
      display: grid;
      align-content: center;
      gap: 8px;
    }
    .health-title {
      font-size: 12px;
      font-weight: 950;
      text-transform: uppercase;
    }
    .health-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 2px solid var(--line);
      background: var(--paper);
      color: var(--ink);
      padding: 5px 9px;
      font-size: 12px;
      font-weight: 850;
      box-shadow: 2px 2px 0 var(--line);
      white-space: nowrap;
    }
    .chip.ok { background: var(--green); }
    .chip.warn { background: var(--orange); }
    .chip.bad,
    .chip.danger { background: var(--red); }
    .chip.blue { background: var(--blue); }
    .chip.pink { background: var(--pink); }
    .subtle { color: var(--muted); font-size: 13px; font-weight: 650; }
    main { margin-top: 18px; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) minmax(240px, 380px) auto;
      gap: 14px;
      margin-bottom: 16px;
      align-items: center;
      padding: 14px;
      border: 3px solid var(--line);
      background: var(--blue);
      box-shadow: var(--shadow);
    }
    input {
      width: 100%;
      min-width: 0;
      height: 46px;
      border: 3px solid var(--line);
      border-radius: 0;
      padding: 0 13px;
      font: inherit;
      font-weight: 750;
      background: var(--paper);
      color: var(--ink);
      box-shadow: var(--shadow-sm);
      outline: none;
    }
    input:focus {
      background: #fff;
      transform: translate(-1px, -1px);
      box-shadow: 5px 5px 0 var(--line);
    }
    label.toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 9px;
      min-height: 46px;
      white-space: nowrap;
      color: var(--ink);
      font-size: 14px;
      font-weight: 850;
      border: 3px solid var(--line);
      background: var(--paper);
      padding: 0 13px;
      box-shadow: var(--shadow-sm);
    }
    label.toggle input {
      width: 18px;
      height: 18px;
      padding: 0;
      box-shadow: none;
      accent-color: var(--pink);
    }
    .layout {
      display: grid;
      grid-template-columns: 250px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .tabs-panel {
      position: sticky;
      top: 14px;
      border: 3px solid var(--line);
      background: var(--paper);
      box-shadow: var(--shadow);
      padding: 12px;
    }
    .tabs-title {
      margin: 0 0 9px;
      font-size: 12px;
      font-weight: 950;
      text-transform: uppercase;
    }
    .tabs {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    button {
      min-height: 42px;
      border: 3px solid var(--line);
      border-radius: 0;
      padding: 0 12px;
      background: var(--paper);
      color: var(--ink);
      font: inherit;
      font-weight: 900;
      cursor: pointer;
      text-align: left;
      box-shadow: 3px 3px 0 var(--line);
      transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease;
    }
    button:hover {
      transform: translate(-1px, -1px);
      box-shadow: 5px 5px 0 var(--line);
    }
    button[aria-selected="true"] {
      background: var(--pink);
    }
    .status {
      min-height: 26px;
      color: var(--muted);
      margin: 0 0 12px;
      font-weight: 800;
    }
    .grid { display: grid; gap: 12px; }
    .overview-grid { grid-template-columns: repeat(auto-fit, minmax(172px, 1fr)); }
    .two-col { grid-template-columns: minmax(0, 1.08fr) minmax(320px, 0.92fr); align-items: start; }
    .three-col { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .card {
      background: var(--paper);
      border: 3px solid var(--line);
      border-radius: 0;
      padding: 16px;
      box-shadow: var(--shadow);
    }
    .card.yellow { background: var(--paper-2); }
    .card.teal { background: var(--teal); }
    .card.green { background: var(--green); }
    .card.pink { background: var(--pink); }
    .card.blue { background: var(--blue); }
    .card.orange { background: var(--orange); }
    .card h2 {
      margin: 0 0 12px;
      font-size: 18px;
      line-height: 1.05;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 12px;
      margin-bottom: 12px;
    }
    .section-title h2 { margin: 0; }
    .metric {
      min-height: 132px;
      display: grid;
      align-content: space-between;
    }
    .metric .label {
      color: var(--ink);
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 950;
    }
    .metric .value {
      font-size: clamp(28px, 4vw, 44px);
      font-weight: 950;
      line-height: 0.95;
      margin: 12px 0 4px;
    }
    .list { display: grid; gap: 8px; }
    .item {
      border: 3px solid var(--line);
      border-radius: 0;
      padding: 12px;
      background: var(--paper);
      box-shadow: var(--shadow-sm);
    }
    .item.soft { background: #fff; }
    .item-title {
      font-weight: 950;
      margin-bottom: 5px;
      overflow-wrap: anywhere;
    }
    .item-detail {
      color: #2a2724;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .item-meta {
      margin-top: 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      align-items: center;
    }
    .table-wrap {
      overflow: auto;
      border: 3px solid var(--line);
      border-radius: 0;
      background: var(--paper);
      box-shadow: var(--shadow);
    }
    table { width: 100%; border-collapse: collapse; min-width: 860px; }
    th, td {
      padding: 12px;
      border-bottom: 3px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--orange);
      color: var(--ink);
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 950;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .content { max-width: 720px; white-space: pre-wrap; line-height: 1.45; overflow-wrap: anywhere; }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 2px 8px;
      border: 2px solid var(--line);
      border-radius: 999px;
      background: var(--paper);
      font-size: 12px;
      font-weight: 950;
      color: var(--ink);
      white-space: nowrap;
    }
    .badge.ok { background: var(--green); }
    .badge.warn { background: var(--orange); }
    .badge.danger { background: var(--red); }
    .badge.info { background: var(--blue); }
    .badge.pink { background: var(--pink); }
    .empty {
      padding: 22px;
      color: var(--ink);
      background: var(--paper);
      border: 3px dashed var(--line);
      border-radius: 0;
      font-weight: 750;
    }
    .error { color: #7a160f; }
    .cards-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .wide-list {
      display: grid;
      gap: 12px;
    }
    .graph-panel {
      min-height: 520px;
      position: relative;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 20%, rgba(94, 234, 212, 0.7) 0 13%, transparent 14%),
        radial-gradient(circle at 78% 62%, rgba(255, 122, 182, 0.65) 0 10%, transparent 11%),
        var(--paper-2);
    }
    .graph-node {
      position: absolute;
      width: 156px;
      min-height: 58px;
      padding: 9px;
      border: 3px solid var(--line);
      border-radius: 0;
      background: var(--paper);
      box-shadow: var(--shadow-sm);
    }
    .graph-node strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .graph-node span { color: var(--muted); font-size: 12px; font-weight: 850; }
    .edge-list { max-height: 520px; overflow: auto; }
    .scope-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .scope-card {
      border: 3px solid var(--line);
      background: #fff;
      padding: 11px;
      box-shadow: var(--shadow-sm);
    }
    .scope-name {
      font-weight: 950;
      overflow-wrap: anywhere;
      margin-bottom: 8px;
    }
    .mini-stats {
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
    }
    details {
      border: 3px solid var(--line);
      background: var(--paper);
      padding: 10px 12px;
      box-shadow: var(--shadow-sm);
    }
    summary {
      cursor: pointer;
      font-weight: 950;
      text-transform: uppercase;
    }
    pre {
      margin: 10px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    @media (max-width: 1020px) {
      .hero { display: grid; }
      .layout { grid-template-columns: 1fr; }
      .tabs-panel { position: static; }
      .tabs { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); }
      .toolbar { grid-template-columns: 1fr; }
      .two-col { grid-template-columns: 1fr; }
    }
    @media (max-width: 620px) {
      .shell { width: min(100% - 20px, 1560px); margin-top: 10px; }
      .hero { padding: 14px; }
      .brand { align-items: flex-start; }
      .logo { width: 46px; height: 46px; font-size: 24px; }
      .cards-list { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="hero">
      <div class="brand">
        <div class="logo">M</div>
        <div>
          <h1>Memory Engine Dashboard</h1>
          <div class="tagline">Coding-agent memory that stays tied to sessions, scopes, graph facts, and repo history.</div>
        </div>
      </div>
      <aside class="hero-side">
        <div class="health-title">System status</div>
        <div id="health" class="health-grid"><span class="chip">Loading</span></div>
      </aside>
    </header>
    <main>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search this view">
        <input id="scope" type="search" placeholder="Scope filter, e.g. project:MEMORY ENGINE TEST">
        <label class="toggle"><input id="includeInternal" type="checkbox">Show demo/test data</label>
      </div>
      <div class="layout">
        <aside class="tabs-panel">
          <p class="tabs-title">Views</p>
          <nav class="tabs" aria-label="Dashboard tabs">
            <button data-tab="overview" aria-selected="true">Overview</button>
            <button data-tab="memories" aria-selected="false">Memories</button>
            <button data-tab="sessions" aria-selected="false">Sessions</button>
            <button data-tab="timeline" aria-selected="false">Timeline</button>
            <button data-tab="graph" aria-selected="false">Graph</button>
            <button data-tab="entities" aria-selected="false">Entities</button>
            <button data-tab="edges" aria-selected="false">Edges</button>
            <button data-tab="activity" aria-selected="false">Activity</button>
            <button data-tab="profile" aria-selected="false">Profile</button>
            <button data-tab="traces" aria-selected="false">Traces</button>
            <button data-tab="audit" aria-selected="false">Audit</button>
            <button data-tab="roadmap" aria-selected="false">Roadmap</button>
          </nav>
        </aside>
        <section>
          <div id="status" class="status"></div>
          <div id="content"></div>
        </section>
      </div>
    </main>
  </div>
  <script>
    const tabs = {
      memories: {
        endpoint: "memories",
        empty: "No memories found. Activate memory in a chat and let memory.remember or hooks capture durable facts.",
        mode: "cards",
        columns: ["status", "type", "content", "scope", "session", "confidence", "validity", "created"]
      },
      timeline: {
        endpoint: "episodes",
        empty: "No timeline events found. Automatic hooks and memory.remember create episode history.",
        mode: "timeline",
        columns: ["kind", "source", "content", "scope", "session", "occurred"]
      },
      sessions: {
        endpoint: "sessions",
        empty: "No sessions found. Use memory.activate at the start of a chat window.",
        mode: "cards",
        columns: ["status", "title", "task", "agent", "scope", "memoryCount", "episodeCount", "started", "ended"]
      },
      entities: {
        endpoint: "entities",
        empty: "No entities found yet.",
        mode: "cards",
        columns: ["kind", "name", "scope", "attrs", "created"]
      },
      edges: {
        endpoint: "edges",
        empty: "No edges found yet.",
        mode: "cards",
        columns: ["relation", "source", "target", "fact", "scope", "validity"]
      },
      activity: {
        endpoint: "activity",
        empty: "No activity yet.",
        mode: "timeline",
        columns: ["kind", "title", "detail", "scope", "session", "occurred"]
      },
      audit: {
        endpoint: "audit",
        empty: "No audit events yet. Invalidated, archived, superseded, and stale memories appear here.",
        mode: "cards",
        columns: ["kind", "status", "detail", "scope", "created"]
      },
      traces: {
        endpoint: "traces",
        empty: "No traces yet. Retrieval and memory-write decisions will appear here after memory.search, activate, or remember runs.",
        mode: "traces",
        columns: ["kind", "summary", "scope", "query", "latency", "payload", "created"]
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
        if (active === "roadmap") {
          renderRoadmap();
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
      health.innerHTML =
        chip("DB " + (payload.health.database ? "OK" : "DOWN"), payload.health.database ? "ok" : "bad") +
        chip("Embeddings " + payload.health.providers.embeddings, "blue") +
        chip("LLM " + payload.health.providers.llm, payload.health.providers.llm === "hosted" ? "ok" : "warn") +
        chip("Rerank " + payload.health.providers.rerank, "pink");
      content.innerHTML =
        '<div class="grid overview-grid">' +
        metric("Sessions", counts.sessions, counts.activeSessions + " active", "teal") +
        metric("Memories", counts.memories, counts.activeMemories + " active", "green") +
        metric("Episodes", counts.episodes, "captured events", "blue") +
        metric("Graph", counts.entities + " nodes", counts.edges + " edges", "pink") +
        metric("Needs Review", counts.needsRevalidation, "stale anchors", counts.needsRevalidation > 0 ? "orange" : "yellow") +
        metric("Inactive", counts.invalidMemories + counts.archivedMemories, "invalid + archived", "yellow") +
        '</div>' +
        '<div class="grid two-col" style="margin-top:12px">' +
        card("Recent Sessions", list(payload.overview.recentSessions.map(sessionItem)), "yellow") +
        card("Recent Memories", list(payload.overview.recentMemories.map(memoryItem)), "teal") +
        '</div>' +
        '<div class="card" style="margin-top:12px"><div class="section-title"><h2>Project Scopes</h2><span class="chip">' + payload.overview.scopes.length + ' shown</span></div>' +
        renderScopes(payload.overview.scopes) +
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
        '<div class="card edge-list pink"><div class="section-title"><h2>Edges</h2><span class="chip">' + edges.length + '</span></div>' + list(edges.map(edgeItem)) + '</div>' +
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
        '<div class="card yellow"><h2>' + escapeHtml(profile.scope) + '</h2>' +
        '<div class="grid overview-grid">' +
        metric("Sessions", profile.sessions, "", "teal") +
        metric("Memories", profile.memories, "", "green") +
        metric("Episodes", profile.episodes, "", "blue") +
        metric("Graph", profile.entities + " nodes", profile.edges + " edges", "pink") +
        '</div>' +
        '<div class="grid two-col" style="margin-top:12px">' +
        card("Top Entities", list((profile.topEntities || []).map(entityItem)), "paper") +
        card("Recent Memories", list((profile.recentMemories || []).map(memoryItem)), "paper") +
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
      } else if (config.mode === "cards") {
        content.innerHTML = '<div class="cards-list">' + rows.map((row) => cardFor(tab, row)).join("") + '</div>';
      } else if (config.mode === "timeline") {
        content.innerHTML = '<div class="wide-list">' + rows.map((row) => timelineItem(tab, row)).join("") + '</div>';
      } else if (config.mode === "traces") {
        content.innerHTML = '<div class="wide-list">' + rows.map(traceItem).join("") + '</div>';
      } else {
        content.innerHTML = renderTable(rows, config.columns);
      }
      status.textContent = rows.length + " rows" + hiddenNote();
    }

    function renderRoadmap() {
      const rows = [
        ["Lessons", "Use procedural memories today; add a separate lessons table only after the workflow proves it needs one."],
        ["Actions", "Future follow-up tasks can live here with pending, active, done, and blocked states."],
        ["Crystals", "Session summaries can be promoted here after consolidation is trusted."],
        ["Replay", "The raw event stream already exists in Timeline; playback controls can be added later."]
      ];
      content.innerHTML = '<div class="cards-list">' + rows.map(([title, text], index) =>
        '<div class="card ' + ["teal", "green", "pink", "blue"][index] + '"><h2>' + escapeHtml(title) + '</h2><p class="item-detail">' + escapeHtml(text) + '</p></div>'
      ).join("") + '</div>';
      status.textContent = "Planned surfaces";
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

    function metric(label, value, hint, tone) {
      return '<div class="card metric ' + escapeHtml(tone || "") + '"><div class="label">' + escapeHtml(label) + '</div><div><div class="value">' + escapeHtml(value) + '</div><div class="subtle">' + escapeHtml(hint || "") + '</div></div></div>';
    }
    function card(title, body, tone) {
      return '<div class="card ' + escapeHtml(tone || "") + '"><h2>' + escapeHtml(title) + '</h2>' + body + '</div>';
    }
    function list(items) {
      if (!items.length) return '<div class="empty">Nothing here yet.</div>';
      return '<div class="list">' + items.join("") + '</div>';
    }
    function memoryItem(row) {
      return '<div class="item soft"><div class="item-title">' + escapeHtml(row.content || "") + '</div><div class="item-meta">' + statusBadge(row.status) + chip(row.type || "memory", "info") + chip("confidence " + Number(row.confidence || 0).toFixed(2), "") + chip(shortScope(row.scope), "pink") + '</div></div>';
    }
    function sessionItem(row) {
      return '<div class="item soft"><div class="item-title">' + escapeHtml(row.title || row.task || "Untitled session") + '</div><div class="item-detail">' + escapeHtml(row.agent || "agent") + '</div><div class="item-meta">' + statusBadge(row.status) + chip((row.memoryCount || 0) + " memories", "green") + chip((row.episodeCount || 0) + " episodes", "blue") + chip(shortScope(row.scope), "pink") + '</div></div>';
    }
    function entityItem(row) {
      return '<div class="item soft"><div class="item-title">' + escapeHtml(row.name || "") + '</div><div class="item-meta">' + chip(row.kind || "entity", "info") + chip(shortScope(row.scope), "pink") + '</div></div>';
    }
    function edgeItem(row) {
      return '<div class="item soft"><div class="item-title">' + escapeHtml((row.source || "?") + " -> " + (row.target || "?")) + '</div><div class="item-detail">' + escapeHtml(row.fact || row.relation || "") + '</div><div class="item-meta">' + chip(row.relation || "relation", "info") + chip(shortScope(row.scope), "pink") + '</div></div>';
    }
    function cardFor(tab, row) {
      if (tab === "memories") return '<article class="item"><div class="item-title">' + escapeHtml(row.content || "") + '</div><div class="item-meta">' + statusBadge(row.status) + chip(row.type || "memory", "info") + chip("confidence " + Number(row.confidence || 0).toFixed(2), "green") + chip(shortScope(row.scope), "pink") + '</div><div class="subtle" style="margin-top:10px">' + escapeHtml(validity(row)) + '</div></article>';
      if (tab === "sessions") return '<article class="item"><div class="item-title">' + escapeHtml(row.title || row.task || "Untitled session") + '</div><div class="item-detail">' + escapeHtml(row.task || "") + '</div><div class="item-meta">' + statusBadge(row.status) + chip(row.agent || "agent", "info") + chip((row.memoryCount || 0) + " memories", "green") + chip((row.episodeCount || 0) + " episodes", "blue") + chip(shortScope(row.scope), "pink") + '</div></article>';
      if (tab === "entities") return entityItem(row);
      if (tab === "edges") return edgeItem(row);
      if (tab === "audit") return '<article class="item"><div class="item-title">' + escapeHtml(row.detail || "") + '</div><div class="item-meta">' + chip(row.kind || "audit", "warn") + statusBadge(row.status) + chip(shortScope(row.scope), "pink") + '</div></article>';
      return '<article class="item"><div class="item-title">' + escapeHtml(row.title || row.name || row.kind || "Item") + '</div><div class="item-detail">' + escapeHtml(row.content || row.detail || row.fact || "") + '</div></article>';
    }
    function timelineItem(tab, row) {
      const title = tab === "timeline" ? row.source : row.title;
      const detail = tab === "timeline" ? row.content : row.detail;
      const when = tab === "timeline" ? row.occurredAt : row.occurredAt;
      return '<article class="item"><div class="section-title"><div><div class="item-title">' + escapeHtml(title || row.kind || "event") + '</div><div class="subtle">' + escapeHtml(date(when)) + '</div></div>' + chip(row.kind || "event", "info") + '</div><div class="item-detail">' + escapeHtml(detail || "") + '</div><div class="item-meta">' + chip(shortScope(row.scope), "pink") + (row.sessionId ? chip(shortId(row.sessionId), "blue") : "") + '</div></article>';
    }
    function traceItem(row) {
      return '<article class="item"><div class="section-title"><div><div class="item-title">' + escapeHtml(row.summary || row.kind || "trace") + '</div><div class="subtle">' + escapeHtml(date(row.createdAt)) + '</div></div>' + chip(row.kind || "trace", row.kind === "ingest" ? "green" : "blue") + '</div><div class="item-meta">' + chip(shortScope(row.scope || "global"), "pink") + chip(row.latencyMs == null ? "no latency" : Number(row.latencyMs).toFixed(1) + "ms", "info") + '</div><details style="margin-top:12px"><summary>Payload</summary><pre>' + escapeHtml(row.payload ? JSON.stringify(row.payload, null, 2) : "{}") + '</pre></details></article>';
    }
    function renderScopes(rows) {
      if (!rows.length) return '<div class="empty">No scopes found.</div>';
      return '<div class="scope-grid">' + rows.map((row) =>
        '<div class="scope-card"><div class="scope-name">' + escapeHtml(row.scope) + '</div><div class="mini-stats">' + chip(row.sessions + " sessions", "teal") + chip(row.memories + " memories", "green") + chip(row.episodes + " episodes", "blue") + '</div></div>'
      ).join("") + '</div>';
    }
    function graphNodes(nodes) {
      return nodes.slice(0, 60).map((node, index) => {
        const angle = (index / Math.max(nodes.length, 1)) * Math.PI * 2;
        const ring = 122 + (index % 4) * 38;
        const x = 58 + Math.cos(angle) * ring + 250;
        const y = 58 + Math.sin(angle) * ring + 205;
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
        return '<td>' + chip(row[column] || "", toneFor(row[column])) + '</td>';
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
    function chip(text, tone) {
      return '<span class="chip ' + escapeHtml(tone || "") + '">' + escapeHtml(text || "") + '</span>';
    }
    function statusBadge(status) {
      return chip(status || "unknown", toneFor(status));
    }
    function toneFor(value) {
      if (value === "active" || value === "done") return "ok";
      if (value === "invalid" || value === "failed") return "danger";
      if (value === "archived" || value === "needs_revalidation" || value === "pending") return "warn";
      if (value === "semantic" || value === "retrieve") return "blue";
      if (value === "ingest" || value === "message") return "green";
      return "";
    }
    function shortScope(value) {
      const text = String(value || "");
      return text.length > 36 ? text.slice(0, 33) + "..." : text;
    }
    function shortId(value) {
      const text = String(value || "");
      return text.length > 10 ? text.slice(0, 8) : text;
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
