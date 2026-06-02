import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../lib/config.js";

export type SqlClient = postgres.Sql;
export type DbClient = ReturnType<typeof drizzle>;

let sqlClient: SqlClient | undefined;
let dbClient: DbClient | undefined;

export function getSqlClient(): SqlClient {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required to connect to Postgres");
  }

  sqlClient ??= postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return sqlClient;
}

export function getDb(): DbClient {
  dbClient ??= drizzle(getSqlClient());
  return dbClient;
}

export async function checkDatabase(): Promise<boolean> {
  try {
    await getSqlClient()`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
  }

  sqlClient = undefined;
  dbClient = undefined;
}
