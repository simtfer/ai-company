import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  ContextPack,
  Position,
  Report,
  SessionRef,
  Task,
} from "../domain/schema";
import { ReportSchema } from "../domain/schema";
import {
  SessionExpiredError,
  reportFor,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessRunResult,
  type HarnessUsage,
} from "../adapters/types";
import { GitWorkspaceManager, type PreparedWorkspace } from "../workspace/git-workspace";
import type { RemoteArtifact } from "./protocol";

export interface RemoteExecutionInput {
  run_id: string;
  task: Task;
  position: Position;
  context: ContextPack;
  workspace_root?: string;
}

export interface RemoteExecutionOutput {
  report: Report;
  session_id?: string;
  usage?: HarnessUsage;
  artifacts: RemoteArtifact[];
  events: HarnessEvent[];
}

interface TestResult {
  command: string;
  passed: boolean;
  exit_code: number | null;
  output: string;
}

function resolveMaybe(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function usableSession(
  position: Position,
  adapter: HarnessAdapter,
  cwd: string,
  session: SessionRef | null,
): SessionRef | null {
  if (!session || session.status !== "active") return null;
  if (session.harness_kind !== adapter.kind) return null;
  if (session.cwd !== cwd) return null;
  if (position.model && session.model && position.model !== session.model) {
    return null;
  }
  if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
    return null;
  }
  return session;
}

export class RemoteTaskExecutor {
  private readonly adapters = new Map<string, HarnessAdapter>();
  readonly workspaceManager: GitWorkspaceManager;

  constructor(
    adapters: HarnessAdapter[],
    workspaceManager = new GitWorkspaceManager(),
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.kind, adapter);
    }
    this.workspaceManager = workspaceManager;
  }

  async execute(input: RemoteExecutionInput): Promise<RemoteExecutionOutput> {
    const { task, position, context } = input;
    const adapter = this.adapters.get(position.harness_kind);
    if (!adapter) {
      const report = reportFor(
        {
          run_id: input.run_id,
          task,
          position,
          context,
          cwd: position.workspace,
          instruction: context.instruction,
        },
        "failed",
        `No harness adapter for "${position.harness_kind}" on this node.`,
        { risks: ["adapter missing"], next: ["install/register harness"] },
      );
      return { report, artifacts: [], events: [] };
    }

    const baseRoot = input.workspace_root ?? process.cwd();
    const workspace = this.prepareWorkspace(
      task,
      position,
      adapter,
      baseRoot,
    );
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent): void => {
      events.push(event);
    };
    const sessionRef = (context.session_ref as SessionRef | null) ?? null;
    const session = usableSession(position, adapter, workspace.cwd, sessionRef);
    const timeoutMs =
      task.budget.minutes && task.budget.minutes > 0
        ? Math.min(task.budget.minutes, 60) * 60_000
        : 10 * 60_000;

    const runInput = {
      run_id: input.run_id,
      task,
      position,
      context,
      cwd: workspace.cwd,
      instruction: context.instruction || task.objective,
      timeout_ms: timeoutMs,
    };

    let result: HarnessRunResult;
    try {
      if (session?.session_id && adapter.resume) {
        try {
          result = await adapter.resume(session.session_id, runInput, emit);
        } catch (error) {
          if (!(error instanceof SessionExpiredError)) throw error;
          emit({
            type: "status",
            status: "session_expired",
            message: error.message,
          });
          result = await adapter.start(runInput, emit);
        }
      } else {
        result = await adapter.start(runInput, emit);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message });
      result = {
        report: reportFor(
          runInput,
          "failed",
          `${adapter.kind} 执行失败：${message}`,
          { risks: [message], next: ["由 CEO 决定重试或转派"] },
        ),
        events: [{ type: "error", message }],
        usage: {},
      };
    }

    const test =
      result.report.status === "done"
        ? this.runTest(task, workspace.cwd)
        : null;
    let finalized;
    try {
      finalized = this.workspaceManager.finalize(workspace, task, input.run_id);
    } catch (error) {
      finalized = {
        changes: [],
        changed_files: [],
        diff_path: null,
        diff: "",
      };
      result.report.risks.push(
        `workspace finalize failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const artifacts: RemoteArtifact[] = [];
    const evidence = [...result.report.evidence];
    const risks = [...result.report.risks];
    let failedByTest = false;
    let failedByPush = false;
    const pushSetting =
      task.constraints.push_remote ?? position.policy.push_remote;
    if (
      finalized.changes.length > 0 &&
      (pushSetting === true || typeof pushSetting === "string")
    ) {
      const pushed = this.workspaceManager.push(
        workspace,
        typeof pushSetting === "string" ? pushSetting : "origin",
      );
      if (pushed.ok) {
        evidence.push({
          kind: "git_push",
          remote: pushed.remote,
          ref: pushed.ref,
          branch: pushed.branch,
        });
        for (const change of finalized.changes) {
          change.remote = pushed.remote;
          change.pushed_ref = pushed.ref;
        }
      } else {
        failedByPush = true;
        risks.push(`git push failed: ${pushed.stderr || pushed.ref}`);
        evidence.push({
          kind: "git_push",
          remote: pushed.remote,
          ref: pushed.ref,
          result: "failed",
          error: pushed.stderr,
        });
      }
    }

    if (test) {
      failedByTest = !test.passed;
      evidence.push({
        kind: "test",
        command: test.command,
        result: test.passed ? "pass" : "fail",
        exit_code: test.exit_code,
        output_tail: test.output.slice(-2000),
      });
      artifacts.push({
        kind: "test",
        filename: `${input.run_id}.test.txt`,
        content: `$ ${test.command}\nexit: ${test.exit_code}\n\n${test.output}\n`,
      });
      if (!test.passed) risks.push(`测试命令失败：${test.command}`);
    }
    if (finalized.diff) {
      artifacts.push({
        kind: "diff",
        filename: `${input.run_id}.diff`,
        content: finalized.diff,
      });
    }

    const status: Report["status"] =
      failedByTest || failedByPush ? "failed" : result.report.status;
    let summary = result.report.summary;
    if (failedByTest) {
      summary += `\n\n测试失败（${test?.command}）：\n${test?.output.slice(-1500)}`;
    }
    if (failedByPush) {
      summary += `\n\n共享分支推送失败，控制平面无法集成此分支。`;
    }
    const branch = workspace.branch || result.report.handoff.branch;
    const next =
      status === "failed"
        ? ["由 CEO 决定重试或转派"]
        : result.report.next.length
          ? result.report.next
          : ["由 CEO 验收"];

    const report = ReportSchema.parse({
      ...result.report,
      status,
      summary: summary.slice(0, 12_000),
      changes:
        finalized.changes.length > 0
          ? finalized.changes
          : result.report.changes,
      evidence,
      risks,
      handoff: {
        ...result.report.handoff,
        state:
          status === "done"
            ? test?.passed
              ? "实现与测试完成"
              : "实现完成"
            : result.report.handoff.state,
        branch,
        open_issues: [
          ...result.report.handoff.open_issues,
          ...(failedByTest ? [`测试失败：${task.constraints.test_command}`] : []),
          ...(failedByPush ? ["git push 失败"] : []),
        ],
        next_steps:
          result.report.handoff.next_steps.length > 0
            ? result.report.handoff.next_steps
            : next,
      },
      next,
    });

    return {
      report,
      session_id: result.session_id,
      usage: result.usage,
      artifacts,
      events,
    };
  }

  private prepareWorkspace(
    task: Task,
    position: Position,
    adapter: HarnessAdapter,
    baseRoot: string,
  ): PreparedWorkspace {
    const workspacePath = resolveMaybe(baseRoot, position.workspace);
    if (adapter.kind === "fake" || position.policy.worktree === false) {
      mkdirSync(workspacePath, { recursive: true });
      return {
        cwd: workspacePath,
        repo: workspacePath,
        branch: "",
        base_ref: "",
        is_git: false,
      };
    }
    const baseRepo =
      typeof position.policy.repo_path === "string"
        ? resolveMaybe(baseRoot, position.policy.repo_path)
        : workspacePath;
    const baseRef =
      typeof task.constraints.base_ref === "string"
        ? task.constraints.base_ref
        : undefined;
    return this.workspaceManager.prepare(baseRepo, task.id, baseRef);
  }

  private runTest(task: Task, cwd: string): TestResult | null {
    const command = task.constraints.test_command;
    if (typeof command !== "string" || !command.trim()) return null;
    const result = spawnSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      timeout: 5 * 60_000,
      windowsHide: true,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return {
      command,
      passed: result.status === 0,
      exit_code: result.status,
      output: `${output}\n${result.error ? result.error.message : ""}`.trim().slice(-8000),
    };
  }
}
