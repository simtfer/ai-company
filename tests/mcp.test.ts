import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let directory: string;
let dbPath: string;
let client: Client | null = null;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-mcp-"));
  dbPath = join(directory, "company.db");
});

afterEach(async () => {
  if (client) {
    await client.close();
    client = null;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("exposes the CEO tools and runs the demo over stdio", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    env.AIC_DB_PATH = dbPath;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
        join(process.cwd(), "src", "cli.ts"),
        "mcp",
      ],
      cwd: process.cwd(),
      env,
      stderr: "pipe",
    });
    client = new Client(
      { name: "m0-test", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("company_brief");
    expect(names).toContain("company_plan_create");
    expect(names).toContain("company_task_continue");
    expect(names).toContain("company_demo");

    const result = await client.callTool({
      name: "company_demo",
      arguments: { goal: "MCP smoke test" },
    });
    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    expect(text).toContain("executions");
    expect(text).toContain("MCP smoke test");
  }, 20_000);
});
