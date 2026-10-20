import type { Position } from "./domain/schema";
import { ensureSampleRepo } from "./demo/sample-project";
import type { CompanyService, ExecutionResult, PlanResult } from "./service/company-service";

export interface CodeDemoResult {
  plan: PlanResult;
  executions: ExecutionResult[];
  status: Record<string, unknown>;
}

function ensurePosition(
  service: CompanyService,
  name: string,
  kind: string,
  model: string | undefined,
  repo: string,
): Position {
  const existing = service.store.getPositionByName(name);
  if (existing) return existing;
  return service.hirePosition({
    name,
    role: "engineer",
    harness_kind: kind,
    workspace: repo,
    ...(model ? { model } : {}),
  });
}

/**
 * Real code-edit demo for Claude Code and pi. Both work in separate
 * worktrees of the disposable sample repo; the service runs node --test and
 * records the result as evidence.
 */
export async function runCodeDemo(
  service: CompanyService,
): Promise<CodeDemoResult> {
  const repo = ensureSampleRepo();
  ensurePosition(service, "claude-code-1", "claude-code", undefined, repo);
  ensurePosition(
    service,
    "pi-1",
    "pi",
    "qianwenai/deepseek-v4.1-flash-1017",
    repo,
  );

  const plan = service.createPlan({
    title: "M1 Claude + pi 代码修改",
    goal: "验证 Claude Code 和 pi 的真实代码修改、测试和 worktree",
    tasks: [
      {
        key: "claude",
        title: "Claude Code 添加 goodbye",
        objective:
          "In hello.mjs add `export function goodbye(name)` returning `Goodbye, <name>!`. " +
          "In hello.test.mjs add a node:test case asserting goodbye('M1') === 'Goodbye, M1!'. " +
          "Do not change existing exports or tests. Run node --test.",
        acceptance: ["goodbye exists", "node --test passes"],
        depends_on: [],
        assignee: "claude-code-1",
        priority: 0,
        constraints: {
          test_command: "node --test",
          write_scope: ["hello.mjs", "hello.test.mjs"],
          allowed_tools: ["Bash(node --test*)"],
        },
      },
      {
        key: "pi",
        title: "pi 添加 shout",
        objective:
          "In hello.mjs add `export function shout(text)` returning text.toUpperCase(). " +
          "In hello.test.mjs add a node:test case asserting shout('m1') === 'M1'. " +
          "Do not change existing exports or tests. Run node --test.",
        acceptance: ["shout exists", "node --test passes"],
        depends_on: [],
        assignee: "pi-1",
        priority: 0,
        constraints: {
          test_command: "node --test",
          write_scope: ["hello.mjs", "hello.test.mjs"],
        },
      },
    ],
  });

  service.assignAll(plan.thread.id);
  const executions = await service.runReady(plan.thread.id);

  return {
    plan,
    executions,
    status: service.status(),
  };
}
