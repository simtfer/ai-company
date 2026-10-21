import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { findClaudeCommand } from "../src/adapters/discovery";
import { harnessEnvironment } from "../src/adapters/env";
import { CompanyService } from "../src/service/company-service";

const root = join(process.cwd(), ".aic", "ceo-pi-test", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const repo = join(root, "repo");
const dbPath = join(root, "company.db");
const mcpConfigPath = join(root, "mcp.json");
const transcriptPath = join(root, "claude-stream.jsonl");
const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const cliEntry = join(process.cwd(), "src", "cli.ts");

function git(args: string[], cwd = repo): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupRepo(): void {
  mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "AI Company Test"]);
  git(["config", "user.email", "test@ai-company.local"]);
  writeFileSync(
    join(repo, "hello.mjs"),
    'export function hello() {\n  return "hello";\n}\n',
  );
  writeFileSync(
    join(repo, "hello.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { hello } from "./hello.mjs";',
      "",
      'test("hello returns hello", () => {',
      '  assert.equal(hello(), "hello");',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "ceo-pi-test", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  git(["add", "."]);
  git(["commit", "-m", "chore: initialize CEO/pi test repo"]);
}

function writeMcpConfig(): void {
  const config = {
    mcpServers: {
      "ai-company": {
        command: process.execPath,
        args: [tsxCli, cliEntry, "mcp"],
        env: { AIC_DB_PATH: dbPath },
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
}

const ALLOWED_TOOLS = [
  "company_brief",
  "company_status",
  "company_inbox",
  "company_plan_create",
  "company_task_assign_all",
  "company_run_ready",
  "company_integration_create",
  "company_position_hire",
  "company_adapters",
  "company_metrics",
  "company_threads",
  "company_task_wait",
  "company_task_continue",
  "company_decision_resolve",
].map((name) => `mcp__ai-company__${name}`).join(",");

const CEO_PROMPT = `You are the CEO of an AI company. You must use the ai-company MCP tools; do not edit code yourself.

Repository: ${repo}
Goal: run TWO rounds of work with two pi positions in ONE thread, then create and run an integration task.

Round 1:
- Hire pi-1 and pi-2 as harness_kind "pi", model "qianwenai/deepseek-v4.1-flash-1017", workspace "${repo}", policy {"worktree": true}.
- Create one task DAG (company_plan_create) titled "Round 1":
  1. key "greet", assignee "pi-1": create greet.mjs exporting greet(name) returning "Hello, <name>!", create greet.test.mjs with a node:test case, keep existing files/tests.
  2. key "shout", assignee "pi-2": create shout.mjs exporting shout(text) returning text.toUpperCase(), create shout.test.mjs with a node:test case.
  Both tasks: acceptance includes node --test passes; constraints { "test_command": "node --test" }; depends_on [].
- Use the returned thread id with company_task_assign_all, then company_run_ready.

Round 2:
- Create a second task DAG titled "Round 2" with the SAME thread_id returned by Round 1:
  1. key "goodbye", assignee "pi-1": create goodbye.mjs exporting goodbye(name) returning "Goodbye, <name>!" and goodbye.test.mjs.
  2. key "whisper", assignee "pi-2": create whisper.mjs exporting whisper(text) returning text.toLowerCase() and whisper.test.mjs.
  Same constraints.
- Assign and run it too.

Integration:
- Call company_integration_create { thread_id: <same thread id>, assignee: "pi-1", title: "Integrate round 1 and 2", test_command: "node --test" }.
- Then company_task_assign_all with the thread id, and company_run_ready again.
- Verify the integration task is done and node --test passes on the integrated branch.

After that, call company_status and company_inbox. Reply with a concise report: positions, rounds, integration task, task ids/statuses, test result, and any risks. Do not ask the human questions.`;

async function main(): Promise<void> {
  setupRepo();
  writeMcpConfig();
  const claude = findClaudeCommand();
  if (!claude) throw new Error("Claude Code not found");
  const env = { ...process.env, ...harnessEnvironment() };
  const args = [
    "-p",
    CEO_PROMPT,
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    ALLOWED_TOOLS,
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "100",
  ];
  console.log("CEO", claude);
  console.log("DB", dbPath);
  console.log("REPO", repo);

  const child = spawn(claude, args, {
    cwd: process.cwd(),
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  let resultText = "";
  const stream: Array<Record<string, any>> = [];
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          const event = JSON.parse(line);
          stream.push(event);
          if (event.type === "assistant") {
            for (const block of event.message?.content ?? []) {
              if (block.type === "text") {
                console.log("CEO_TEXT", block.text.slice(0, 500));
              }
              if (block.type === "tool_use") {
                console.log("CEO_TOOL", block.name, JSON.stringify(block.input).slice(0, 500));
              }
            }
          }
          if (event.type === "result") {
            resultText = event.result ?? "";
            console.log("CEO_RESULT", resultText.slice(0, 2000));
          }
        } catch {
          // ignore non-JSON
        }
      }
      idx = buffer.indexOf("\n");
    }
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    const text = String(chunk);
    if (text.trim()) console.error("STDERR", text.slice(0, 1000));
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
  });
  writeFileSync(transcriptPath, `${stream.map((e) => JSON.stringify(e)).join("\n")}\n`);

  const service = new CompanyService({ dbPath, seed: false });
  try {
    const positions = service.store.listPositions();
    const tasks = service.store.listTasks();
    const threads = service.threads();
    console.log(
      "VERIFY",
      JSON.stringify(
        {
          exitCode,
          result: resultText.slice(0, 1000),
          positions: positions.map((p) => ({
            name: p.name,
            harness: p.harness_kind,
            status: p.status,
          })),
          threads: threads.map((t) => ({
            title: t.title,
            task_status: t.task_status,
          })),
          tasks: tasks.map((task) => {
            const report = service.store.getLatestReportForTask(task.id);
            return {
              id: task.id,
              title: task.title,
              assignee: task.assignee,
              status: task.status,
              report: report?.status,
              summary: report?.summary?.slice(0, 200),
            };
          }),
        },
        null,
        2,
      ),
    );
  } finally {
    service.close();
  }
  console.log("TRANSCRIPT", transcriptPath);
  if (exitCode !== 0) process.exitCode = 1;
}

await main();
