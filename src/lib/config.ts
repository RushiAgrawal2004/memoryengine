import "dotenv/config";

export interface Config {
  databaseUrl?: string;
  port: number;
}

const DEFAULT_PORT = 3777;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawPort = env.PORT;
  const port = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_PORT;

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, received: ${rawPort}`);
  }

  return {
    databaseUrl: env.DATABASE_URL,
    port,
  };
}

export const config = loadConfig();
