import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  BudgetExceededError,
  CompanyService,
} from "../src/service/company-service";

let directory: string;
let service: CompanyService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-m4-"));
  service = new CompanyService({
    dbPath: join(directory, "company.db"),
    fakeDelayMs: 0,
  });
});

afterEach(() => {
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function simplePlan(
  extra: {
    max_retries?: number;
    constraints?: Record<string, unknown>;
  } = {},
) {
  return service.createPlan({
    title: "M4 test",
    goal: "M4 test",
    tasks: [
      {
        key: "work",
        title: "do work",
        objective: "do work",
        acceptance: ["done"],
        depends_on: [],
        assignee: "frontend-1",
        priority: 0,
        ...extra,
      },
    ],
  });
}

describe("M4 budgets, retries, review and operations", () => {
  it("hard-stops dispatch when a budget is exhausted", async () => {
    service.setCompanyBudget(0);
    const plan = simplePlan();
    service.assignAll(plan.thread.id);

    await expect(service.runReady(plan.thread.id)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it("hard-stops dispatch when the minute budget is exhausted", async () => {
    service.setCompanyBudget(50, 0);
    const plan = simplePlan();
    service.assignAll(plan.thread.id);

    await expect(service.runReady(plan.thread.id)).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it("automatically retries a failed task up to max_retries", async () => {
    const plan = simplePlan({
      max_retries: 1,
      constraints: { fake_status: "failed" },
    });
    service.assignAll(plan.thread.id);
    const results = await service.runReady(plan.thread.id);

    expect(results).toHaveLength(2);
    expect(service.store.getTask(plan.tasks[0].id)?.status).toBe("failed");
    expect(service.store.getTask(plan.tasks[0].id)?.attempts).toBe(1);
    expect(service.store.listReportsForTask(plan.tasks[0].id)).toHaveLength(2);
  });

  it("creates an independent review task and merge queue entry", async () => {
    const plan = simplePlan();
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);
    const taskId = plan.tasks[0].id;

    const review = service.requestReview(taskId, "qa-1");
    expect(review.review_task.assignee).toBe("qa-1");
    expect(review.merge_entry.status).toBe("pending_review");

    service.assignTask(review.review_task.id);
    await service.runReady(plan.thread.id);
    expect(service.mergeQueue("ready")).toHaveLength(1);

    const merged = service.approveMerge(review.merge_entry.id as string);
    expect(merged.status).toBe("merged");
  });

  it("fast-forward merges a ready branch into the local repo", () => {
    const repo = join(directory, "merge-repo");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.com"]);
    writeFileSync(join(repo, "hello.txt"), "hello\n");
    git(["add", "."]);
    git(["commit", "-m", "initial"]);

    git(["checkout", "-b", "task/merge-test"]);
    writeFileSync(join(repo, "hello.txt"), "hello\nmerged\n");
    git(["add", "."]);
    git(["commit", "-m", "feature"]);
    const commit = git(["rev-parse", "HEAD"]);
    git(["checkout", "main"]);

    const plan = simplePlan();
    const entry = {
      id: "mq_git_test",
      company_id: "c_main",
      task_id: plan.tasks[0].id,
      review_task_id: null,
      repo,
      branch: "task/merge-test",
      commit,
      merge_commit: null,
      status: "ready" as const,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    service.store.insertMergeQueue(entry);
    const merged = service.approveMerge(entry.id);

    expect(merged.status).toBe("merged");
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toContain("merged");
    expect(git(["log", "-1", "--pretty=%s"])).toBe("feature");
  });

  it("exposes metrics and memory search", async () => {
    const plan = simplePlan();
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);

    const metrics = service.metrics();
    expect((metrics.tasks as { total: number }).total).toBeGreaterThan(0);
    expect(
      (metrics.budgets as { company: { budget_usd: number } }).company.budget_usd,
    ).toBe(50);

    const memory = service.searchMemory("playbook");
    expect((memory.results as unknown[]).length).toBeGreaterThan(0);
  });

  it("backs up the SQLite database to a restorable file", async () => {
    const plan = simplePlan();
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);

    mkdirSync(join(directory, "backups"), { recursive: true });
    const backup = join(directory, "backups", "company.db");
    service.backupTo(backup);
    expect(existsSync(backup)).toBe(true);

    const restored = new CompanyService({ dbPath: backup, seed: false });
    try {
      expect(restored.store.getTask(plan.tasks[0].id)?.status).toBe("done");
    } finally {
      restored.close();
    }
  });
});
