import cron from "node-cron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";
import { getSqlClient, closeDb } from "../db/client.js";
import { getEmbeddings } from "../providers/embeddings.js";
import { getLLM } from "../providers/llm.js";
import { config } from "../lib/config.js";
import { latestFileCommit } from "../grounding/git.js";
import { ingestFacts } from "../write/memory-ops.js";
import { ExtractedFact } from "../write/extract.js";

interface ConsolidationLogger {
  log(message: string): void;
  error?(message: string): void;
}

export interface ConsolidationOptions {
  now?: Date;
  scope?: string;
  episodeLimit?: number;
  decayDays?: number;
  decayFloor?: number;
  cwd?: string;
  logger?: ConsolidationLogger;
}

export interface PassResult {
  name: string;
  checked: number;
  changed: number;
}

export interface ConsolidationResult {
  reflect: PassResult;
  decay: PassResult;
  revalidate: PassResult;
}

interface EpisodeRow {
  id: string;
  scope: string;
  content: string;
}

interface StaleMemoryRow {
  id: string;
  scope: string;
  content: string;
  attrs: Record<string, unknown> | null;
  anchors: Array<{ path?: string; symbol?: string; commit?: string }> | null;
}

const CLUSTER_THRESHOLD = 0.7;

const revalidationSchema = z.object({
  op: z.enum(["UPDATE", "INVALIDATE", "NOOP"]),
  content: z.string().optional(),
});

export async function runConsolidationOnce(
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  const logger = options.logger ?? console;
  const reflect = await reflectPass(options);
  logger.log(`[consolidate] REFLECT checked=${reflect.checked} changed=${reflect.changed}`);

  const decay = await decayPass(options);
  logger.log(`[consolidate] DECAY checked=${decay.checked} changed=${decay.changed}`);

  const revalidate = await revalidatePass(options);
  logger.log(
    `[consolidate] RE-VALIDATE checked=${revalidate.checked} changed=${revalidate.changed}`,
  );

  return { reflect, decay, revalidate };
}

export function startConsolidationLoop(
  options: ConsolidationOptions = {},
): ReturnType<typeof cron.schedule> {
  const logger = options.logger ?? console;
  return cron.schedule(config.consolidateCron, () => {
    runConsolidationOnce(options).catch((error: unknown) => {
      logger.error?.(`[consolidate] failed: ${String(error)}`);
    });
  });
}

export async function reflectPass(
  options: ConsolidationOptions = {},
): Promise<PassResult> {
  const sql = getSqlClient();
  const episodeLimit = options.episodeLimit ?? config.reflectEpisodeLimit;
  const rows = options.scope
    ? await sql<EpisodeRow[]>`
        select id, scope, content
        from episodes
        where scope = ${options.scope}
        order by occurred_at desc
        limit ${episodeLimit}
      `
    : await sql<EpisodeRow[]>`
        select id, scope, content
        from episodes
        order by occurred_at desc
        limit ${episodeLimit}
      `;

  if (rows.length === 0) {
    return { name: "REFLECT", checked: 0, changed: 0 };
  }

  const vectors = await getEmbeddings().embed(rows.map((row) => row.content));
  const clusters = clusterEpisodes(rows, vectors);
  let changed = 0;

  for (const cluster of clusters.filter((item) => item.length >= 2)) {
    const scope = cluster[0].scope;
    const summary = await getLLM().chat(
      "Summarize recent related memory episodes into 0-3 durable semantic or procedural memories. Return one memory per line.",
      `Episodes:\n${cluster.map((row) => `- ${row.content}`).join("\n")}`,
    );
    const facts = await newFactsOnly(
      scope,
      summary
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
        .filter(Boolean)
        .slice(0, 3),
    );

    if (facts.length === 0) {
      continue;
    }

    const operations = await ingestFacts(facts, {
      scope,
      sourceEpisode: cluster[0].id,
    });
    changed += operations.filter((operation) => operation.op !== "NOOP").length;
  }

  return { name: "REFLECT", checked: rows.length, changed };
}

export async function decayPass(
  options: ConsolidationOptions = {},
): Promise<PassResult> {
  const sql = getSqlClient();
  const now = options.now ?? new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - (options.decayDays ?? config.decayDays));
  const floor = options.decayFloor ?? config.decayFloor;

  return sql.begin(async (tx) => {
    const decayed = options.scope
      ? await tx<Array<{ id: string }>>`
          update memories
          set confidence = greatest(confidence - 0.1, 0)
          where status = 'active'
            and scope = ${options.scope}
            and coalesce(last_used_at, created_at) < ${cutoff}
          returning id
        `
      : await tx<Array<{ id: string }>>`
          update memories
          set confidence = greatest(confidence - 0.1, 0)
          where status = 'active'
            and coalesce(last_used_at, created_at) < ${cutoff}
          returning id
        `;

    const archived = options.scope
      ? await tx<Array<{ id: string }>>`
          update memories
          set status = 'archived'
          where status = 'active'
            and scope = ${options.scope}
            and confidence < ${floor}
          returning id
        `
      : await tx<Array<{ id: string }>>`
          update memories
          set status = 'archived'
          where status = 'active'
            and confidence < ${floor}
          returning id
        `;

    return {
      name: "DECAY",
      checked: decayed.length,
      changed: decayed.length + archived.length,
    };
  });
}

export async function revalidatePass(
  options: ConsolidationOptions = {},
): Promise<PassResult> {
  const sql = getSqlClient();
  const cwd = options.cwd ?? process.cwd();
  const rows = options.scope
    ? await sql<StaleMemoryRow[]>`
        select id, scope, content, attrs, anchors
        from memories
        where status = 'active'
          and scope = ${options.scope}
          and coalesce((attrs->>'needs_revalidation')::boolean, false)
      `
    : await sql<StaleMemoryRow[]>`
        select id, scope, content, attrs, anchors
        from memories
        where status = 'active'
          and coalesce((attrs->>'needs_revalidation')::boolean, false)
      `;

  let changed = 0;

  for (const row of rows) {
    const anchor = row.anchors?.find((item) => item.path);
    if (!anchor?.path) {
      continue;
    }

    const fileContent = await readFile(path.join(cwd, anchor.path), "utf8").catch(() => "");
    const decision = await getLLM().json(
      "Revalidate a repo-grounded memory against current file content. Choose UPDATE, INVALIDATE, or NOOP.",
      [
        `Memory: ${row.content}`,
        `Anchor path: ${anchor.path}`,
        "Current file content:",
        fileContent,
      ].join("\n"),
      revalidationSchema,
    );

    const attrs = { ...(row.attrs ?? {}), needs_revalidation: false };

    if (decision.op === "NOOP") {
      await sql`
        update memories
        set attrs = ${sql.json(attrs as never)}
        where id = ${row.id}
      `;
      changed += 1;
      continue;
    }

    if (decision.op === "UPDATE") {
      const latestCommit = await latestFileCommit(anchor.path, cwd);
      const anchors = (row.anchors ?? []).map((item) =>
        item.path === anchor.path && latestCommit
          ? { ...item, commit: latestCommit }
          : item,
      );
      await sql`
        update memories
        set content = ${decision.content ?? row.content},
            attrs = ${sql.json(attrs as never)},
            anchors = ${sql.json(anchors as never)},
            last_used_at = now()
        where id = ${row.id}
      `;
      changed += 1;
      continue;
    }

    await sql`
      update memories
      set status = 'invalid',
          t_invalid = now(),
          t_expired = now(),
          attrs = ${sql.json(attrs as never)}
      where id = ${row.id}
    `;
    changed += 1;
  }

  return { name: "RE-VALIDATE", checked: rows.length, changed };
}

async function newFactsOnly(scope: string, contents: string[]): Promise<ExtractedFact[]> {
  const sql = getSqlClient();
  const facts: ExtractedFact[] = [];

  for (const content of contents) {
    const [existing] = await sql<Array<{ id: string }>>`
      select id
      from memories
      where scope = ${scope}
        and content = ${content}
      limit 1
    `;

    if (!existing) {
      facts.push({ fact: content, temporalRefs: [] });
    }
  }

  return facts;
}

function clusterEpisodes(rows: EpisodeRow[], vectors: number[][]): EpisodeRow[][] {
  const clusters: Array<{ rows: EpisodeRow[]; centroid: number[] }> = [];

  rows.forEach((row, index) => {
    const vector = vectors[index];
    const match = clusters.find(
      (cluster) =>
        cluster.rows[0]?.scope === row.scope
        && cosineSimilarity(cluster.centroid, vector) >= CLUSTER_THRESHOLD,
    );

    if (match) {
      match.rows.push(row);
      match.centroid = averageVectors(match.rows.map((clusterRow) => vectors[rows.indexOf(clusterRow)]));
    } else {
      clusters.push({ rows: [row], centroid: vector });
    }
  });

  return clusters.map((cluster) => cluster.rows);
}

function averageVectors(vectors: number[][]): number[] {
  const length = vectors[0]?.length ?? 0;
  const average = Array.from({ length }, () => 0);

  for (const vector of vectors) {
    for (let i = 0; i < length; i += 1) {
      average[i] += vector[i] / vectors.length;
    }
  }

  return average;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) {
    return 0;
  }

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    aMagnitude += a[i] * a[i];
    bMagnitude += b[i] * b[i];
  }

  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }

  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

if (process.argv.includes("--once")) {
  runConsolidationOnce()
    .finally(async () => {
      await closeDb();
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
} else if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"))) {
  startConsolidationLoop();
}
