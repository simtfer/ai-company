import type { ContextPack, Position, Report, Task } from "../domain/schema";
import { ReportSchema } from "../domain/schema";

export interface FakeExecutionInput {
  task: Task;
  position: Position;
  context: ContextPack;
  instruction?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class FakeHarness {
  readonly kind = "fake";

  constructor(private readonly delayMs = 5) {}

  async execute(input: FakeExecutionInput): Promise<Report> {
    if (this.delayMs > 0) {
      await sleep(this.delayMs);
    }

    const { task, position, context } = input;
    const constraints = task.constraints ?? {};
    const forcedStatus = asString(constraints.fake_status);
    const continuation = input.instruction?.trim();
    const sessionNote = context.session_ref ? "复用已有会话" : "新建会话";
    const qa = position.role.toLowerCase() === "qa";

    if (forcedStatus === "failed") {
      return ReportSchema.parse({
        schema: "report/v1",
        task_id: task.id,
        status: "failed",
        summary: `「${task.title}」执行失败：Fake Harness 按测试配置返回 failed。`,
        changes: [],
        evidence: [],
        handoff: {
          state: "执行失败，未产生有效变更",
          branch: `task/${task.id}`,
          open_issues: ["Fake Harness 模拟失败"],
          next_steps: ["由 CEO 决定重试或转派"],
          decisions_needed: [],
        },
        risks: ["失败为测试配置触发"],
        next: ["重试或转派"],
      });
    }

    if (forcedStatus === "blocked") {
      return ReportSchema.parse({
        schema: "report/v1",
        task_id: task.id,
        status: "blocked",
        summary: `「${task.title}」被阻塞：缺少必要输入。`,
        changes: [],
        evidence: [],
        handoff: {
          state: "等待输入",
          branch: `task/${task.id}`,
          open_issues: ["缺少上游产物或权限"],
          next_steps: ["补齐输入后继续"],
          decisions_needed: ["是否由 CEO 协调上游任务"],
        },
        risks: ["阻塞会占用任务时限"],
        next: ["补齐输入", "重新派工"],
      });
    }

    if (forcedStatus === "needs_decision" || constraints.requires_decision === true) {
      const question =
        asString(constraints.decision_question) ??
        `「${task.title}」需要 CEO/人类确认一个关键选择。`;
      const options = Array.isArray(constraints.decision_options)
        ? (constraints.decision_options as unknown[]).map(String)
        : ["按推荐方案继续", "暂停并等待", "取消任务"];
      return ReportSchema.parse({
        schema: "report/v1",
        task_id: task.id,
        status: "needs_decision",
        summary: `「${task.title}」已推进到需要决策的节点。`,
        changes: [],
        evidence: [],
        handoff: {
          state: "等待决策后继续",
          branch: `task/${task.id}`,
          open_issues: [question],
          next_steps: ["记录决策后恢复执行"],
          decisions_needed: [question],
        },
        risks: [],
        next: ["等待决策"],
        decision: { question, options },
      });
    }

    const delta = continuation
      ? `已根据追加要求更新：${continuation}`
      : qa
        ? "验收通过，未发现阻塞项。"
        : "实现完成，已提交到任务分支。";

    return ReportSchema.parse({
      schema: "report/v1",
      task_id: task.id,
      status: "done",
      summary: `「${task.title}」${delta}（${sessionNote}）`,
      changes: qa
        ? []
        : [
            {
              repo: "demo",
              branch: `task/${task.id}`,
              commit: `fake-${task.id.slice(-6)}`,
            },
          ],
      evidence: [
        {
          kind: "test",
          command: "fake-check",
          result: "pass",
        },
      ],
      handoff: {
        state: qa ? "验收完成" : "实现完成，等待后续验收",
        branch: `task/${task.id}`,
        open_issues: [],
        next_steps: qa ? ["汇总最终报告"] : ["QA 回归", "合并到 integration"],
        decisions_needed: [],
      },
      risks: [],
      next: qa ? ["汇总最终报告"] : ["QA 回归", "合并到 integration"],
    });
  }
}
