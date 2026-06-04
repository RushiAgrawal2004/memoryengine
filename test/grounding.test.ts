import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { currentRepoRef, listChangedFiles, repoNameFromTopLevel } from "../src/grounding/git.js";
import { flagStaleMemories } from "../src/grounding/staleness.js";

const execFileAsync = promisify(execFile);

describe("repo grounding", () => {
  const scopes: string[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    const sql = getSqlClient();
    for (const scope of scopes.splice(0)) {
      await sql`delete from memories where scope = ${scope}`;
    }

    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("reads current repo refs and changed files via git CLI", async () => {
    const repoRef = await currentRepoRef();
    expect(repoRef?.repo).toBe("memoryengine");
    expect(repoRef?.branch).toBeTruthy();
    expect(repoRef?.commit).toMatch(/^[0-9a-f]{40}$/);

    const changed = await listChangedFiles("HEAD~1");
    expect(Array.isArray(changed)).toBe(true);
  });

  it("derives repo names from git paths with trailing separators", () => {
    expect(repoNameFromTopLevel("E:/MEMORY ENGINE TEST/")).toBe("MEMORY ENGINE TEST");
    expect(repoNameFromTopLevel("E:\\memoryengine\\")).toBe("memoryengine");
  });

  it("flags anchored memories when the file changed after the anchor commit", async () => {
    const tempRepo = await makeTempRepo();
    const scope = testScope();
    const sql = getSqlClient();

    await writeFile(path.join(tempRepo, "auth.ts"), "export const value = 1;\n");
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "add auth file"]);
    const anchorCommit = (await git(tempRepo, ["rev-parse", "HEAD"])).trim();

    await sql`
      insert into memories (type, scope, content, anchors, status)
      values (
        'semantic',
        ${scope},
        'auth.ts validates tokens',
        ${sql.json([{ path: "auth.ts", commit: anchorCommit }] as never)},
        'active'
      )
    `;

    await writeFile(path.join(tempRepo, "auth.ts"), "export const value = 2;\n");
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "change auth file"]);

    const audit = await flagStaleMemories(scope, tempRepo);
    expect(audit.newlyFlagged).toBe(1);
    expect(audit.needsRevalidation).toBe(1);
  }, 20000);

  it("exposes memory.audit over MCP", async () => {
    const client = new Client({ name: "grounding-smoke", version: "0.1.0" });
    const transport = new StdioClientTransport({
      command: "node",
      args: ["E:/memoryengine/dist/src/index.js", "--stdio"],
      cwd: "E:/memoryengine",
      stderr: "pipe",
    });

    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();

    expect(tools.tools.map((tool) => tool.name)).toContain("memory.audit");
  }, 15000);

  function testScope(): string {
    const scope = `test:${crypto.randomUUID()}`;
    scopes.push(scope);
    return scope;
  }

  async function makeTempRepo(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "memoryengine-grounding-"));
    tempDirs.push(dir);
    await git(dir, ["init"]);
    await git(dir, ["config", "user.email", "test@example.com"]);
    await git(dir, ["config", "user.name", "Test User"]);
    return dir;
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}
