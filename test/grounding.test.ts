import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { closeDb, getSqlClient } from "../src/db/client.js";
import { handleGitPostCommit } from "../src/grounding/post-commit.js";
import { currentRepoRef, listChangedFiles, repoNameFromTopLevel } from "../src/grounding/git.js";
import { flagStaleMemories } from "../src/grounding/staleness.js";
import { hashSymbolInFile } from "../src/grounding/symbols.js";
import { LocalHeuristicLLM, setLLMForTest } from "../src/providers/llm.js";

const execFileAsync = promisify(execFile);

describe("repo grounding", () => {
  const scopes: string[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    setLLMForTest(undefined);
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

  it("flags symbol anchors only when the anchored symbol body changes", async () => {
    const tempRepo = await makeTempRepo();
    const scope = testScope();
    const sql = getSqlClient();

    await writeFile(
      path.join(tempRepo, "auth.ts"),
      [
        "export function verifyToken(token: string) {",
        "  return token.length > 0;",
        "}",
        "",
        "export const unrelated = 1;",
        "",
      ].join("\n"),
    );
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "add auth symbols"]);
    const anchorCommit = (await git(tempRepo, ["rev-parse", "HEAD"])).trim();
    const symbol = await hashSymbolInFile("auth.ts", "verifyToken", tempRepo);
    expect(symbol).toBeTruthy();

    await sql`
      insert into memories (type, scope, content, anchors, status)
      values (
        'semantic',
        ${scope},
        'verifyToken rejects empty tokens',
        ${sql.json([{
          path: "auth.ts",
          symbol: "verifyToken",
          commit: anchorCommit,
          ...symbol,
        }] as never)},
        'active'
      )
    `;

    await writeFile(
      path.join(tempRepo, "auth.ts"),
      [
        "export function verifyToken(token: string) {",
        "  return token.length > 0;",
        "}",
        "",
        "export const unrelated = 2;",
        "",
      ].join("\n"),
    );
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "change unrelated symbol"]);

    const unrelatedAudit = await flagStaleMemories(scope, tempRepo, ["auth.ts"]);
    expect(unrelatedAudit.newlyFlagged).toBe(0);
    expect(unrelatedAudit.needsRevalidation).toBe(0);

    await writeFile(
      path.join(tempRepo, "auth.ts"),
      [
        "export function verifyToken(token: string) {",
        "  return token.startsWith('Bearer ');",
        "}",
        "",
        "export const unrelated = 2;",
        "",
      ].join("\n"),
    );
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "change verifyToken"]);

    const symbolAudit = await flagStaleMemories(scope, tempRepo, ["auth.ts"]);
    expect(symbolAudit.newlyFlagged).toBe(1);
    expect(symbolAudit.needsRevalidation).toBe(1);
  }, 20000);

  it("handles git post-commit changed files for the affected repo scope", async () => {
    setLLMForTest(new LocalHeuristicLLM());
    const tempRepo = await makeTempRepo("post-commit-repo");
    const scope = `project:${path.basename(tempRepo)}`;
    scopes.push(scope);
    const sql = getSqlClient();

    await writeFile(
      path.join(tempRepo, "auth.ts"),
      [
        "export function verifyToken(token: string) {",
        "  return token.length > 0;",
        "}",
        "",
      ].join("\n"),
    );
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "add auth"]);
    const anchorCommit = (await git(tempRepo, ["rev-parse", "HEAD"])).trim();
    const symbol = await hashSymbolInFile("auth.ts", "verifyToken", tempRepo);

    await sql`
      insert into memories (type, scope, content, anchors, status)
      values (
        'semantic',
        ${scope},
        'verifyToken accepts non-empty tokens',
        ${sql.json([{ path: "auth.ts", symbol: "verifyToken", commit: anchorCommit, ...symbol }] as never)},
        'active'
      )
    `;

    await writeFile(
      path.join(tempRepo, "auth.ts"),
      [
        "export function verifyToken(token: string) {",
        "  return token.startsWith('Bearer ');",
        "}",
        "",
      ].join("\n"),
    );
    await git(tempRepo, ["add", "auth.ts"]);
    await git(tempRepo, ["commit", "-m", "tighten auth"]);

    const result = await handleGitPostCommit({
      cwd: tempRepo,
      changedFiles: ["auth.ts"],
    });

    expect(result.scope).toBe(scope);
    expect(result.audit.newlyFlagged).toBe(1);
    expect(result.revalidate.checked).toBe(1);
    expect(result.revalidate.changed).toBe(1);
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

  async function makeTempRepo(prefix = "memoryengine-grounding"): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
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
