import type { Position } from "./domain/schema";
import { ensureSampleRepo } from "./demo/sample-project";
import type {
  CompanyService,
  ExecutionResult,
  PlanResult,
} from "./service/company-service";

export interface OpencodeDemoResult {
  plan: PlanResult;
  repo: string;
  dev: ExecutionResult;
  qa: ExecutionResult | null;
  reports: Array<{ title: string; status: string; summary: string }>;
  status: Record<string, unknown>;
}

function ensurePosition(
  service: CompanyService,
  name: string,
  role: string,
  repo: string,
): Position {
  const existing = service.store.getPositionByName(name);
  if (existing) return existing;
  return service.hirePosition({
    name,
    role,
    harness_kind: "opencode",
    model: "deepseek/deepseek-flash",
    workspace: repo,
  });
}

/**
 * Real opencode end-to-end demo:
 * 1. A dev position edits a disposable git repository through a task worktree.
 * 2. A QA position starts from the dev branch, reviews and runs tests.
 *
 * This costs a small amount of model usage and requires opencode auth.
 */
export async function runOpencodeDemo(
  service: CompanyService,
  goal = "Add a greet function and a test to the demo project.",
): Promise<OpencodeDemoResult> {
  const repo = ensureSampleRepo();
  ensurePosition(service, "opencode-dev", "engineer", repo);
  ensurePosition(service, "opencode-qa", "qa", repo);

  const plan = service.createPlan({
    title: "M1 opencode 真实闭环",
    goal,
    tasks: [
      {
        key: "dev",
        title: "实现 greet 函数",
        objective:
          "In hello.mjs add `export function greet(name)` returning `Hello, <name>!`. " +
          "In hello.test.mjs add a node:test case asserting greet('M1') === 'Hello, M1!'. " +
          "Do not change the existing hello function or its test.",
        acceptance: [
          "hello.mjs exports greet(name)",
          "hello.test.mjs covers greet",
          "node --test passes",
        ],
        depends_on: [],
        assignee: "opencode-dev",
        priority: 1,
        constraints: {
          test_command: "node --test",
          write_scope: ["hello.mjs", "hello.test.mjs"],
        },
      },
      {
        key: "qa",
        title: "验收 greet 变更",
        objective:
          "Review the current branch, inspect the greet implementation and test, run node --test, " +
          "and report any defect. Do not rewrite the feature unless the test reveals a real bug.",
        acceptance: [
          "node --test passes",
          "report contains evidence and residual risks",
        ],
        depends_on: ["dev"],
        assignee: "opencode-qa",
        priority: 0,
        constraints: {
          test_command: "node --test",
        },
      },
    ],
  });

  const devTask = plan.tasks.find((task) => task.task_key === "dev");
  const qaTask = plan.tasks.find((task) => task.task_key === "qa");
  if (!devTask || !qaTask) throw new Error("Demo plan is missing tasks");

  service.assignTask(devTask.id);
  const devResults = await service.runReady(plan.thread.id);
  const dev = devResults.find((result) => result.task.id === devTask.id);
  if (!dev) {
    throw new Error("The opencode demo did not produce a dev execution result");
  }
  if (dev.report.status !== "done") {
    return {
      plan,
      repo,
      dev,
      qa: null,
      reports: [
        {
          title: dev.task.title,
          status: dev.report.status,
          summary: dev.report.summary,
        },
      ],
      status: service.status(),
    };
  }

  const devBranch =
    typeof (dev.report.changes[0] as { branch?: unknown } | undefined)?.branch ===
    "string"
      ? String((dev.report.changes[0] as { branch: string }).branch)
      : `task/${devTask.id}`;
  service.store.updateTaskConstraints(qaTask.id, {
    ...qaTask.constraints,
    base_ref: devBranch,
  });
  service.assignTask(qaTask.id);
  const qaResults = await service.runReady(plan.thread.id);
  const qa = qaResults.find((result) => result.task.id === qaTask.id) ?? null;

  return {
    plan,
    repo,
    dev,
    qa,
    reports: [dev, ...(qa ? [qa] : [])].map((result) => ({
      title: result.task.title,
      status: result.report.status,
      summary: result.report.summary,
    })),
    status: service.status(),
  };
}
