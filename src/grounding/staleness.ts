import { getSqlClient } from "../db/client.js";
import { latestFileCommit } from "./git.js";
import { hashSymbolInFile } from "./symbols.js";

interface AnchoredMemory {
  id: string;
  attrs: Record<string, unknown> | null;
  anchors: Array<{
    path?: string;
    symbol?: string;
    commit?: string;
    symbolHash?: string;
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
  changedFiles?: string[],
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
  const changedFileSet = changedFiles ? normalizedFileSet(changedFiles) : undefined;

  for (const memory of memories) {
    const stale = await isMemoryStale(memory, cwd, changedFileSet);
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
    if (!memory.attrs?.needs_revalidation) {
      newlyFlagged += 1;
    }
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

async function isMemoryStale(
  memory: AnchoredMemory,
  cwd: string,
  changedFiles?: Set<string>,
): Promise<boolean> {
  for (const anchor of memory.anchors ?? []) {
    if (!anchor.path) {
      continue;
    }
    if (changedFiles && !changedFiles.has(normalizeFile(anchor.path))) {
      continue;
    }

    if (anchor.symbol) {
      if (!anchor.symbolHash) {
        continue;
      }

      const current = await hashSymbolInFile(anchor.path, anchor.symbol, cwd);
      if (!current || current.symbolHash !== anchor.symbolHash) {
        return true;
      }
      continue;
    }

    if (!anchor.commit) {
      continue;
    }
    const latest = await latestFileCommit(anchor.path, cwd);
    if (latest && latest !== anchor.commit) {
      return true;
    }
  }

  return false;
}

function normalizedFileSet(files: string[]): Set<string> {
  return new Set(files.map(normalizeFile));
}

function normalizeFile(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\/+/, "");
}
