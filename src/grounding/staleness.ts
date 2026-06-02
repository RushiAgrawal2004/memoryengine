import { getSqlClient } from "../db/client.js";
import { latestFileCommit } from "./git.js";

interface AnchoredMemory {
  id: string;
  attrs: Record<string, unknown> | null;
  anchors: Array<{
    path?: string;
    commit?: string;
  }> | null;
}

export interface MemoryAudit {
  active: number;
  invalid: number;
  needsRevalidation: number;
  newlyFlagged: number;
}

export async function flagStaleMemories(
  scope: string,
  cwd = process.cwd(),
): Promise<MemoryAudit> {
  const sql = getSqlClient();
  const memories = await sql<AnchoredMemory[]>`
    select id, attrs, anchors
    from memories
    where scope = ${scope}
      and status = 'active'
      and anchors is not null
  `;

  let newlyFlagged = 0;

  for (const memory of memories) {
    const stale = await isMemoryStale(memory, cwd);
    if (!stale) {
      continue;
    }

    const attrs = {
      ...(memory.attrs ?? {}),
      needs_revalidation: true,
    };

    await sql`
      update memories
      set attrs = ${sql.json(attrs as never)}
      where id = ${memory.id}
    `;
    newlyFlagged += 1;
  }

  return memoryAudit(scope, newlyFlagged);
}

export async function memoryAudit(
  scope: string,
  newlyFlagged = 0,
): Promise<MemoryAudit> {
  const sql = getSqlClient();
  const [row] = await sql<Array<{
    active: number;
    invalid: number;
    needsRevalidation: number;
  }>>`
    select
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'invalid')::int as invalid,
      count(*) filter (
        where coalesce((attrs->>'needs_revalidation')::boolean, false)
      )::int as "needsRevalidation"
    from memories
    where scope = ${scope}
  `;

  return {
    active: row.active,
    invalid: row.invalid,
    needsRevalidation: row.needsRevalidation,
    newlyFlagged,
  };
}

async function isMemoryStale(memory: AnchoredMemory, cwd: string): Promise<boolean> {
  for (const anchor of memory.anchors ?? []) {
    if (!anchor.path || !anchor.commit) {
      continue;
    }

    const latest = await latestFileCommit(anchor.path, cwd);
    if (latest && latest !== anchor.commit) {
      return true;
    }
  }

  return false;
}
