import { closeDb, getSqlClient } from "../db/client.js";
import { searchMemories } from "../db/memories.js";
import { remember } from "../write/remember.js";

const DEFAULT_SCOPE = "project:todo-codex-demo";
const scope = process.env.SCENARIO_SCOPE ?? DEFAULT_SCOPE;
const reset = process.argv.includes("--reset");

const scenarioFacts = [
  "The user wants Codex to build a simple todo list web app.",
  "The todo app should let users add tasks, mark tasks complete, delete tasks, and filter all, active, and completed tasks.",
  "The todo app should persist tasks in localStorage so refresh does not lose items.",
  "The UI should be clean, responsive, and usable as the first screen, not a marketing landing page.",
  "Use this memory engine dashboard to inspect captured memories, entities, edges, and episodes for the todo app scenario.",
];

async function main(): Promise<void> {
  if (reset) {
    await resetScope(scope);
  }

  for (const fact of scenarioFacts) {
    await remember({ scope, text: fact });
  }

  const results = await searchMemories({
    scope,
    query: "what should Codex build for the todo app",
    limit: 5,
  });

  console.log(`Scenario scope: ${scope}`);
  console.log("Seeded todo-app memory. Search results:");
  for (const result of results) {
    console.log(`- ${result.content}`);
  }
  console.log("");
  console.log("Dashboard:");
  console.log(`  http://localhost:${process.env.PORT ?? "3777"}/viewer`);
  console.log("");
  console.log("Use this prompt in Codex after MCP is connected:");
  console.log(
    `  Search memory scope "${scope}" first, then build a simple todo list web app from the remembered requirements.`,
  );
}

async function resetScope(targetScope: string): Promise<void> {
  const sql = getSqlClient();
  await sql`delete from edges where scope = ${targetScope}`;
  await sql`delete from entities where scope = ${targetScope}`;
  await sql`delete from memories where scope = ${targetScope}`;
  await sql`delete from episodes where scope = ${targetScope}`;
}

main()
  .finally(async () => {
    await closeDb();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
