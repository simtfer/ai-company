import type { CompanyService, ExecutionResult, PlanResult } from "./service/company-service";

export const DEMO_GOAL =
  "给官网加一个定价页，三档价格，支持月付/年付切换，并完成测试。";

export interface DemoResult {
  plan: PlanResult;
  executions: ExecutionResult[];
  status: Record<string, unknown>;
}

export async function runDemo(
  service: CompanyService,
  goal = DEMO_GOAL,
): Promise<DemoResult> {
  const plan = service.createPlan({
    title: "官网定价页",
    goal,
    tasks: [
      {
        key: "ui",
        title: "实现定价页 UI",
        objective:
          "在官网新增 /pricing 页面，三档价格，月付/年付切换，遵循现有设计规范。",
        acceptance: ["桌面端和移动端可用", "组件测试通过"],
        depends_on: [],
        assignee: "frontend-1",
        priority: 0,
        constraints: { write_scope: ["apps/web/src/pricing/**"] },
      },
      {
        key: "api",
        title: "价格配置接口",
        objective:
          "提供价格档位和折扣配置接口，支持月付/年付，带输入校验。",
        acceptance: ["接口测试通过", "不破坏现有接口"],
        depends_on: [],
        assignee: "backend-1",
        priority: 0,
      },
      {
        key: "qa",
        title: "验收定价页",
        objective:
          "根据验收标准检查定价页和价格接口，输出测试证据和遗留风险。",
        acceptance: ["核心路径通过", "报告包含证据和风险"],
        depends_on: ["ui", "api"],
        assignee: "qa-1",
        priority: 0,
      },
    ],
  });

  service.assignAll(plan.thread.id);
  const executions = await service.runReady(plan.thread.id);
  plan.tasks = plan.tasks.map((task) => service.store.getTask(task.id) ?? task);

  return {
    plan,
    executions,
    status: service.status(),
  };
}
