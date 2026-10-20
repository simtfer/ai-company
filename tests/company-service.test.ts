import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyService } from "../src/service/company-service";

let directory: string;
let service: CompanyService;
let dbPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-test-"));
  dbPath = join(directory, "company.db");
  service = new CompanyService({ dbPath, fakeDelayMs: 0 });
});

afterEach(() => {
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function createSimplePlan() {
  return service.createPlan({
    title: "测试目标",
    goal: "完成一个可验证的任务",
    tasks: [
      {
        key: "build",
        title: "实现功能",
        objective: "实现一个可测试的功能",
        acceptance: ["测试通过"],
        depends_on: [],
        assignee: "frontend-1",
        priority: 0,
      },
    ],
  });
}

describe("CompanyService", () => {
  it("seeds a company, local node and three fake positions", () => {
    const brief = service.brief();
    expect((brief.company as { name: string }).name).toBe("AI Company");
    expect((brief.positions as unknown[]).length).toBe(3);
    expect(service.nodeList()).toHaveLength(1);
  });

  it("creates a DAG, assigns positions and executes in dependency order", async () => {
    const plan = service.createPlan({
      title: "定价页",
      goal: "实现并验收定价页",
      tasks: [
        {
          key: "ui",
          title: "实现 UI",
          objective: "实现页面",
          acceptance: ["页面可用"],
          depends_on: [],
          assignee: "frontend-1",
          priority: 0,
        },
        {
          key: "api",
          title: "实现接口",
          objective: "实现价格接口",
          acceptance: ["接口通过"],
          depends_on: [],
          assignee: "backend-1",
          priority: 0,
        },
        {
          key: "qa",
          title: "验收",
          objective: "验收页面和接口",
          acceptance: ["核心路径通过"],
          depends_on: ["ui", "api"],
          assignee: "qa-1",
          priority: 0,
        },
      ],
    });

    service.assignAll(plan.thread.id);
    const results = await service.runReady(plan.thread.id);

    expect(results).toHaveLength(3);
    const tasks = plan.tasks.map((task) => service.store.getTask(task.id));
    expect(tasks.every((task) => task?.status === "done")).toBe(true);

    const qaTask = tasks.find((task) => task?.task_key === "qa");
    expect(qaTask).toBeDefined();
    expect(service.store.listDependencies(qaTask!.id)).toHaveLength(2);
    expect(service.store.getLatestReportForTask(qaTask!.id)?.status).toBe(
      "done",
    );

    const status = service.status();
    expect((status.tasks as { by_status: Record<string, number> }).by_status.done).toBe(
      3,
    );
  });

  it("persists tasks and reports across service restarts", async () => {
    const plan = createSimplePlan();
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);
    const taskId = plan.tasks[0].id;

    service.close();
    service = new CompanyService({ dbPath, fakeDelayMs: 0 });

    const task = service.store.getTask(taskId);
    expect(task?.status).toBe("done");
    expect(service.store.listReportsForTask(taskId)).toHaveLength(1);
    expect(service.threads()).toHaveLength(1);
  });

  it("continues a done task and reuses the recorded session/context", async () => {
    const plan = createSimplePlan();
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);
    const taskId = plan.tasks[0].id;

    const result = await service.continueTask(taskId, "年付改成 8 折");
    expect(result.report.status).toBe("done");
    expect(result.report.summary).toContain("8 折");
    expect(service.store.listReportsForTask(taskId)).toHaveLength(2);

    const session = service.store.getSessionRef(result.position.id);
    expect(session?.status).toBe("active");
    expect(session?.context_hash).toBeTruthy();
    expect(service.store.listMemory(result.position.id).length).toBeGreaterThan(0);
  });

  it("creates a decision and resumes the task after it is resolved", async () => {
    const plan = service.createPlan({
      title: "需要决策的目标",
      goal: "验证决策闸门",
      tasks: [
        {
          key: "decide",
          title: "需要决策的任务",
          objective: "推进到需要人类选择的节点",
          acceptance: ["决策已记录"],
          depends_on: [],
          assignee: "frontend-1",
          priority: 0,
          constraints: {
            requires_decision: true,
            decision_question: "选 A 还是 B？",
            decision_options: ["A", "B"],
          },
        },
      ],
    });
    service.assignAll(plan.thread.id);
    const [execution] = await service.runReady(plan.thread.id);

    expect(execution.task.status).toBe("waiting_approval");
    const decisions = service.store.listOpenDecisions();
    expect(decisions).toHaveLength(1);

    service.resolveDecision(decisions[0].id, "A", "测试选择");
    expect(service.store.getTask(execution.task.id)?.status).toBe("assigned");
    expect(service.store.listOpenDecisions()).toHaveLength(0);
  });

  it("holds a task at a pre-flight approval gate before dispatch", async () => {
    const plan = service.createPlan({
      title: "审批闸门",
      goal: "验证执行前审批",
      tasks: [
        {
          key: "approve",
          title: "需要审批的执行",
          objective: "执行一个敏感动作",
          acceptance: ["批准后完成"],
          depends_on: [],
          assignee: "frontend-1",
          priority: 0,
          constraints: {
            requires_approval: true,
            approval_question: "是否执行敏感动作？",
            approval_options: ["批准", "拒绝"],
          },
        },
      ],
    });

    const assigned = service.assignTask(plan.tasks[0].id);
    expect(assigned.status).toBe("waiting_approval");
    const decisions = service.store.listOpenDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].question).toContain("敏感动作");

    service.resolveDecision(decisions[0].id, "批准", "测试批准");
    expect(service.store.getTask(plan.tasks[0].id)?.status).toBe("assigned");

    const results = await service.runReady(plan.thread.id);
    expect(results).toHaveLength(1);
    expect(results[0].report.status).toBe("done");
    expect(service.store.getTask(plan.tasks[0].id)?.status).toBe("done");
  });

  it("marks a task failed when its test command fails", async () => {
    const plan = service.createPlan({
      title: "测试命令失败",
      goal: "验证测试证据闸门",
      tasks: [
        {
          key: "fail-test",
          title: "运行失败测试",
          objective: "执行一个失败的测试命令",
          acceptance: ["测试通过"],
          depends_on: [],
          assignee: "frontend-1",
          priority: 0,
          constraints: {
            test_command: 'node -e "process.exit(1)"',
          },
        },
      ],
    });
    service.assignAll(plan.thread.id);
    const [execution] = await service.runReady(plan.thread.id);

    expect(execution.report.status).toBe("failed");
    expect(execution.task.status).toBe("failed");
    expect(execution.report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "test", result: "fail" }),
      ]),
    );
  });

  it("rejects cyclic task graphs", () => {
    expect(() =>
      service.createPlan({
        title: "循环",
        goal: "验证 DAG 校验",
        tasks: [
          {
            key: "a",
            title: "A",
            objective: "A",
            acceptance: ["A"],
            depends_on: ["b"],
            priority: 0,
          },
          {
            key: "b",
            title: "B",
            objective: "B",
            acceptance: ["B"],
            depends_on: ["a"],
            priority: 0,
          },
        ],
      }),
    ).toThrow(/cycle/);
  });
});
