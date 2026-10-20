#!/usr/bin/env node
import { Command } from "commander";
import { CompanyService } from "./service/company-service";
import { createRealAdapters } from "./adapters";
import { runDemo, DEMO_GOAL } from "./demo";

const program = new Command();

program
  .name("aic")
  .description("AI Company runtime CLI")
  .version("0.1.0")
  .option("--db <path>", "SQLite database path")
  .option("--json", "print machine-readable JSON");

function service(): CompanyService {
  return new CompanyService({
    dbPath: program.opts().db as string | undefined,
    fakeDelayMs: 0,
    adapters: createRealAdapters().adapters,
  });
}

function print(value: unknown): void {
  if (program.opts().json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

program
  .command("init")
  .description("initialize the company database and seed fake positions")
  .action(() => {
    const instance = service();
    try {
      print(instance.brief());
    } finally {
      instance.close();
    }
  });

program
  .command("brief")
  .description("show company handbook, positions and recent threads")
  .action(() => {
    const instance = service();
    try {
      print(instance.brief());
    } finally {
      instance.close();
    }
  });

program
  .command("status")
  .description("show who is doing what")
  .action(() => {
    const instance = service();
    try {
      print(instance.status());
    } finally {
      instance.close();
    }
  });

program
  .command("inbox")
  .description("show recent reports and open decisions")
  .action(() => {
    const instance = service();
    try {
      print(instance.inbox());
    } finally {
      instance.close();
    }
  });

program
  .command("threads")
  .description("list goal threads")
  .action(() => {
    const instance = service();
    try {
      print(instance.threads());
    } finally {
      instance.close();
    }
  });

program
  .command("demo")
  .description("run the M0 CEO -> plan -> fake positions -> report flow")
  .argument("[goal]", "goal for the demo", DEMO_GOAL)
  .action(async (goal: string) => {
    const instance = service();
    try {
      const result = await runDemo(instance, goal);
      print({
        thread: result.plan.thread,
        tasks: result.plan.tasks.map((task) => ({
          id: task.id,
          title: task.title,
          assignee: task.assignee,
          status: task.status,
        })),
        reports: result.executions.map((execution) => ({
          task_id: execution.task.id,
          title: execution.task.title,
          status: execution.report.status,
          summary: execution.report.summary,
        })),
        status: result.status,
      });
    } finally {
      instance.close();
    }
  });

program
  .command("probe")
  .description("probe discovered real harness adapters")
  .action(async () => {
    const instance = new CompanyService({
      dbPath: program.opts().db as string | undefined,
      fakeDelayMs: 0,
      adapters: createRealAdapters().adapters,
    });
    try {
      print(await instance.probeAdapters());
    } finally {
      instance.close();
    }
  });

program
  .command("demo:harnesses")
  .description("verify Claude Code, pi and opencode with a tiny real prompt")
  .action(async () => {
    const { runHarnessDemo } = await import("./demo-harnesses");
    const instance = new CompanyService({
      dbPath: program.opts().db as string | undefined,
      fakeDelayMs: 0,
      adapters: createRealAdapters().adapters,
    });
    try {
      const result = await runHarnessDemo(instance);
      print({
        discovered: result.discovered,
        skipped: result.skipped,
        reports: result.executions.map((execution) => ({
          title: execution.task.title,
          position: execution.task.assignee,
          status: execution.report.status,
          summary: execution.report.summary,
          session_id: (execution.report.evidence.find(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "session_id" in item,
          ) as { session_id?: string } | undefined)?.session_id,
        })),
      });
    } finally {
      instance.close();
    }
  });

program
  .command("demo:code")
  .description("run real Claude Code and pi code edits with test evidence")
  .action(async () => {
    const { runCodeDemo } = await import("./demo-code");
    const instance = new CompanyService({
      dbPath: program.opts().db as string | undefined,
      fakeDelayMs: 0,
      adapters: createRealAdapters().adapters,
    });
    try {
      const result = await runCodeDemo(instance);
      print({
        reports: result.executions.map((execution) => ({
          title: execution.task.title,
          position: execution.task.assignee,
          status: execution.report.status,
          summary: execution.report.summary,
          changes: execution.report.changes,
          evidence: execution.report.evidence,
        })),
        status: result.status,
      });
    } finally {
      instance.close();
    }
  });

program
  .command("demo:sessions")
  .description("verify real session continuation for Claude Code, pi and opencode")
  .action(async () => {
    const { runSessionDemo } = await import("./demo-sessions");
    const instance = new CompanyService({
      dbPath: program.opts().db as string | undefined,
      fakeDelayMs: 0,
      adapters: createRealAdapters().adapters,
    });
    try {
      print(await runSessionDemo(instance));
    } finally {
      instance.close();
    }
  });

program
  .command("demo:opencode")
  .description("run the real opencode M1 demo on a disposable git repository")
  .argument("[goal]", "goal for the demo")
  .action(async (goal: string | undefined) => {
    const { runOpencodeDemo } = await import("./demo-opencode");
    const instance = new CompanyService({
      dbPath: program.opts().db as string | undefined,
      fakeDelayMs: 0,
      adapters: createRealAdapters().adapters,
    });
    try {
      const result = await runOpencodeDemo(instance, goal);
      print({
        repo: result.repo,
        thread: result.plan.thread.id,
        reports: result.reports,
        status: result.status,
        log_dir: ".aic/logs",
        worktrees: ".aic/worktrees",
      });
    } finally {
      instance.close();
    }
  });

program
  .command("mcp")
  .description("start the MCP stdio server for the CEO harness")
  .action(async () => {
    const { startMcpServer } = await import("./mcp-server");
    await startMcpServer(program.opts().db as string | undefined);
  });

program
  .command("serve")
  .description("start the local HTTP runtime API")
  .option("--port <port>", "port", "4317")
  .action(async (options: { port: string }) => {
    const { startHttpServer } = await import("./http-server");
    const port = Number(options.port);
    await startHttpServer({
      dbPath: program.opts().db as string | undefined,
      port,
    });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
