import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_COMPANY_ID,
  type Task,
} from "../src/domain/schema";
import { reportFor, type HarnessAdapter, type HarnessCapabilities, type RunInput } from "../src/adapters/types";
import { CompanyService } from "../src/service/company-service";

class FileAdapter implements HarnessAdapter {
  readonly kind = "file-fake";

  async probe(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      supports_resume: false,
      supports_streaming: false,
      version: "test",
    };
  }

  async start(input: RunInput) {
    const name = input.task.task_key === "a" ? "feature-a.txt" : "feature-b.txt";
    writeFileSync(join(input.cwd, name), `${input.task.title}\n`);
    return {
      report: reportFor(input, "done", `${input.task.title} done`),
      events: [],
      usage: {},
      exit_code: 0,
    };
  }
}

let directory: string;
let repo: string;
let service: CompanyService;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-integration-"));
  repo = join(directory, "repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  writeFileSync(
    join(repo, "check.mjs"),
    'import { existsSync } from "node:fs";\nif (!existsSync("feature-a.txt") || !existsSync("feature-b.txt")) process.exit(1);\n',
  );
  writeFileSync(join(repo, "README.md"), "integration test\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  service = new CompanyService({
    dbPath: join(directory, "company.db"),
    fakeDelayMs: 0,
    adapters: [new FileAdapter()],
  });
});

afterEach(() => {
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function hire(name: string): void {
  service.hirePosition({
    name,
    role: "engineer",
    harness_kind: "file-fake",
    workspace: repo,
  });
}

describe("integration task", () => {
  it("merges multiple task branches and only permits the integration result", async () => {
    hire("dev-a");
    hire("dev-b");
    hire("integrator");
    hire("qa-int");
    const plan = service.createPlan({
      title: "integration test",
      goal: "merge two independent changes",
      tasks: [
        {
          key: "a",
          title: "feature A",
          objective: "write feature A",
          acceptance: ["feature-a.txt"],
          depends_on: [],
          assignee: "dev-a",
          priority: 0,
        },
        {
          key: "b",
          title: "feature B",
          objective: "write feature B",
          acceptance: ["feature-b.txt"],
          depends_on: [],
          assignee: "dev-b",
          priority: 0,
        },
      ],
    });
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);

    const integration = service.createIntegrationTask(plan.thread.id, {
      assignee: "integrator",
      test_command: "node check.mjs",
    });
    service.assignTask(integration.id);
    const results = await service.runReady(plan.thread.id);

    const integrated = service.store.getTask(integration.id);
    expect(integrated?.status).toBe("done");
    const report = service.store.getLatestReportForTask(integration.id);
    expect(report?.status).toBe("done");
    expect(report?.summary).toContain("已集成 2 个任务");
    expect(
      report?.report.evidence.some(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          (item as { kind?: string }).kind === "integration",
      ),
    ).toBe(true);

    expect(
      git(["show", `integration/${plan.thread.id}:feature-a.txt`]),
    ).toContain("feature A");
    expect(
      git(["show", `integration/${plan.thread.id}:feature-b.txt`]),
    ).toContain("feature B");

    const source = service.store.getTask(plan.tasks[0].id) as Task;
    const sourceReport = service.store.getLatestReportForTask(source.id);
    const change = (sourceReport?.report.changes as Array<Record<string, unknown>>)[0];
    service.store.insertMergeQueue({
      id: "mq_source",
      company_id: MAIN_COMPANY_ID,
      task_id: source.id,
      review_task_id: null,
      repo,
      branch: String(change.branch),
      commit: String(change.commit),
      merge_commit: null,
      status: "ready",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    expect(() => service.approveMerge("mq_source")).toThrow(/integration/);
    expect(results.length).toBe(1);

    const review = service.requestReview(integration.id, "qa-int");
    await service.runReady(plan.thread.id);
    const ready = service.mergeQueue("ready").find(
      (entry) => entry.task_id === integration.id,
    );
    expect(ready).toBeDefined();
    const merged = service.approveMerge(ready!.id);
    expect(merged.status).toBe("merged");
    expect(git(["show", "main:feature-a.txt"])).toContain("feature A");
    expect(git(["show", "main:feature-b.txt"])).toContain("feature B");
    expect(review.review_task.assignee).toBe("qa-int");
  });
});
