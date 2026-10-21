import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CreatePlanInputSchema,
  DecisionRequestInputSchema,
  HirePositionInputSchema,
  MAIN_COMPANY_ID,
  LOCAL_NODE_ID,
  ReportSchema,
  type Company,
  type ContextPack,
  type CreatePlanInput,
  type Decision,
  type DecisionRequestInput,
  type HirePositionInput,
  type MergeQueueEntry,
  type Node,
  type Position,
  type Report,
  type ReportStatus,
  type SessionRef,
  type Task,
  type TaskStatus,
  type Thread,
} from "../domain/schema";
import { assertTransition, isTerminal } from "../domain/state";
import { FakeHarness } from "../adapters/fake";
import {
  SessionExpiredError,
  reportFor,
  type ApprovalDecision,
  type ApprovalRequest,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunResult,
  type RunInput,
} from "../adapters/types";
import {
  GitWorkspaceManager,
  type PreparedWorkspace,
  type WorkspaceResult,
} from "../workspace/git-workspace";
import type {
  NodeCompletion,
  NodeEventBatch,
  NodeRegistrationRequest,
  NodeTaskPayload,
} from "../node/protocol";
import { Store, newId, nowIso } from "../store/store";

const DEFAULT_DB_PATH =
  process.env.AIC_DB_PATH ?? join(process.cwd(), ".aic", "company.db");

const HANDBOOK = `# AI Company 员工手册（M1）

## 公司原则
- 人类只与 CEO 沟通，员工没有人类入口。
- 每张任务必须有目标、验收标准和明确的负责人。
- 员工只返回结构化报告，不返回无边界的聊天记录。
- 原生 harness session 只是缓存；任务线程、职位记忆和产物才是长期记忆。

## M1 范围
- Fake Harness 继续作为测试替身。
- 接入真实 opencode；Claude Code 适配器已实现但本机未安装，属于实验性。
- 每个真实任务使用独立 git worktree；session 可 resume，失败则用 Context Pack 重建。
- 任务可声明 test_command；测试结果作为验收证据。
`;

const DEFAULT_POLICY = {
  network: "model_api_only",
  approval: "destructive_ops",
  write_scope: ["**"],
};

const ACTIVE_STATUSES: TaskStatus[] = [
  "assigned",
  "running",
  "waiting_input",
  "waiting_approval",
  "review",
];

export interface CompanyServiceOptions {
  dbPath?: string;
  fakeDelayMs?: number;
  seed?: boolean;
  adapters?: HarnessAdapter[];
  workspaceManager?: GitWorkspaceManager;
  remoteWaitMs?: number;
  approvalTimeoutMs?: number;
}

export interface PlanResult {
  thread: Thread;
  tasks: Task[];
  edges: Array<{ task_id: string; depends_on: string }>;
}

export interface ExecutionResult {
  task: Task;
  position: Position;
  report: Report;
  run_id: string;
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function countByStatus(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

export class CompanyService {
  readonly store: Store;
  readonly fake: FakeHarness;
  readonly workspaceManager: GitWorkspaceManager;
  private readonly adapters = new Map<string, HarnessAdapter>();
  private readonly remoteWaitMs: number;
  private readonly approvalTimeoutMs: number;

  constructor(options: CompanyServiceOptions = {}) {
    this.store = new Store(options.dbPath ?? DEFAULT_DB_PATH);
    this.fake = new FakeHarness(options.fakeDelayMs ?? 5);
    this.workspaceManager =
      options.workspaceManager ?? new GitWorkspaceManager();
    this.remoteWaitMs = options.remoteWaitMs ?? 10 * 60_000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 5 * 60_000;
    this.registerAdapter(this.fake);
    for (const adapter of options.adapters ?? []) {
      this.registerAdapter(adapter);
    }
    if (options.seed !== false) {
      this.seed();
    }
  }

  registerAdapter(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.kind, adapter);
    const node = this.store.getNode();
    if (node) {
      this.store.updateNodeCapabilities(node.id, {
        ...node.capabilities,
        harnesses: this.adapterKinds(),
      });
    }
  }

  adapterKinds(): string[] {
    return [...this.adapters.keys()];
  }

  async probeAdapters(): Promise<HarnessCapabilities[]> {
    const probes: HarnessCapabilities[] = [];
    for (const adapter of this.adapters.values()) {
      probes.push(await adapter.probe());
    }
    return probes;
  }

  close(): void {
    this.store.close();
  }

  // ---------- seed ----------

  seed(): void {
    const existing = this.store.getCompany();
    if (!existing) {
      this.store.insertCompany({
        id: MAIN_COMPANY_ID,
        name: "AI Company",
        handbook: HANDBOOK,
        policy: DEFAULT_POLICY,
        budget: { usd: 50, minutes: 600 },
        created_at: nowIso(),
      });
    }

    const node = this.store.getNode();
    const capabilities = {
      harnesses: this.adapterKinds(),
      max_concurrency: 3,
      remote: false,
    };
    if (!node) {
      this.store.insertNode({
        id: LOCAL_NODE_ID,
        company_id: MAIN_COMPANY_ID,
        name: "local",
        os: process.platform,
        status: "online",
        capabilities,
        last_seen_at: nowIso(),
        kind: "local",
        workspace_root: process.cwd(),
        drain: false,
        revoked_at: null,
        registered_at: nowIso(),
      });
    } else {
      this.store.updateNodeCapabilities(node.id, capabilities);
    }

    const seedPositions: HirePositionInput[] = [
      { name: "frontend-1", role: "frontend", harness_kind: "fake" },
      { name: "backend-1", role: "backend", harness_kind: "fake" },
      { name: "qa-1", role: "qa", harness_kind: "fake" },
    ];
    for (const input of seedPositions) {
      if (!this.store.getPositionByName(input.name)) {
        this.hirePosition(input);
      }
    }
  }

  // ---------- human / CEO views ----------

  brief(): Record<string, unknown> {
    const company = this.requireCompany();
    const node = this.store.getNode();
    const positions = this.store.listPositions();
    const threads = this.store.listThreads().slice(0, 10);
    return {
      schema: "company.brief/v1",
      entry: "CEO harness",
      company: {
        id: company.id,
        name: company.name,
        handbook: company.handbook,
        policy: company.policy,
        budget: company.budget,
      },
      node,
      positions: positions.map((position) => ({
        name: position.name,
        role: position.role,
        harness_kind: position.harness_kind,
        status: position.status,
        workspace: position.workspace,
      })),
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        summary: thread.summary,
        updated_at: thread.updated_at,
      })),
      open_decisions: this.store.listOpenDecisions().length,
      counts: {
        tasks: countByStatus(this.store.listTasks()),
      },
    };
  }

  status(): Record<string, unknown> {
    const tasks = this.store.listTasks();
    const positions = this.store.listPositions().map((position) => {
      const current = tasks.find(
        (task) =>
          task.assignee === position.name &&
          ACTIVE_STATUSES.includes(task.status),
      );
      return {
        name: position.name,
        role: position.role,
        status: position.status,
        current_task: current
          ? {
              id: current.id,
              title: current.title,
              status: current.status,
            }
          : null,
      };
    });
    return {
      schema: "company.status/v1",
      node: this.store.getNode(),
      positions,
      tasks: {
        total: tasks.length,
        by_status: countByStatus(tasks),
      },
      threads: this.store.listThreads().length,
      open_decisions: this.store.listOpenDecisions(),
    };
  }

  inbox(limit = 20): Record<string, unknown> {
    const tasks = this.store
      .listTasks()
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const recent = tasks.slice(0, limit).map((task) => {
      const report = this.store.getLatestReportForTask(task.id);
      return {
        task: {
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          updated_at: task.updated_at,
        },
        report: report
          ? {
              status: report.status,
              summary: report.summary,
              created_at: report.created_at,
            }
          : null,
      };
    });
    return {
      schema: "company.inbox/v1",
      recent,
      open_decisions: this.store.listOpenDecisions(),
      blocked: tasks
        .filter((task) => task.status === "blocked")
        .map((task) => ({ id: task.id, title: task.title })),
      failed: tasks
        .filter((task) => task.status === "failed")
        .map((task) => ({ id: task.id, title: task.title })),
    };
  }

  threads(): Array<Record<string, unknown>> {
    return this.store.listThreads().map((thread) => {
      const tasks = this.store.listTasks(MAIN_COMPANY_ID, thread.id);
      return {
        ...thread,
        task_count: tasks.length,
        task_status: countByStatus(tasks),
      };
    });
  }

  // ---------- planning ----------

  createIntegrationTask(
    threadId: string,
    input: {
      title?: string;
      assignee: string;
      test_command?: string;
      source_task_ids?: string[];
    },
  ): Task {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    const all = this.store.listTasks(MAIN_COMPANY_ID, threadId);
    const sourceIds = input.source_task_ids?.length
      ? input.source_task_ids
      : all
          .filter((task) => task.constraints.integration !== true)
          .map((task) => task.id);
    if (sourceIds.length === 0) {
      throw new Error("Integration task needs at least one source task");
    }
    const sources = sourceIds.map((id) => {
      const source = all.find((task) => task.id === id);
      if (!source) throw new Error(`Source task not in thread: ${id}`);
      return source;
    });
    const inheritedTest = sources
      .map((task) => task.constraints.test_command)
      .find((value): value is string => typeof value === "string");
    const now = nowIso();
    const task: Task = {
      id: newId("t"),
      company_id: MAIN_COMPANY_ID,
      thread_id: thread.id,
      parent_task_id: null,
      task_key: `integration-${newId("k")}`,
      title: input.title ?? `集成 ${thread.title}`,
      objective: `把 ${sources.length} 个已完成任务的分支合并到 integration/${thread.id}，运行集成测试并产出最终 diff。`,
      assignee: input.assignee,
      status: "queued",
      priority: 0,
      acceptance: ["集成分支包含所有 source task", "集成测试通过"],
      constraints: {
        integration: true,
        integration_source_task_ids: sources.map((source) => source.id),
        ...(input.test_command ?? inheritedTest
          ? { test_command: input.test_command ?? inheritedTest }
          : {}),
      },
      inputs: [],
      budget: {},
      deadline: null,
      attempts: 0,
      max_retries: 0,
      lease_owner: null,
      lease_expires_at: null,
      lease_token: null,
      created_at: now,
      updated_at: now,
    };
    this.store.transaction(() => {
      this.store.insertTask(task);
      for (const source of sources) {
        this.store.addTaskEdge(task.id, source.id);
      }
    });
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "integration.created",
      payload: {
        thread_id: thread.id,
        source_task_ids: sources.map((source) => source.id),
      },
      created_at: nowIso(),
    });
    return task;
  }

  createPlan(input: CreatePlanInput): PlanResult {
    const plan = CreatePlanInputSchema.parse(input);
    const keys = new Set<string>();
    for (const task of plan.tasks) {
      if (keys.has(task.key)) {
        throw new Error(`Duplicate task key: ${task.key}`);
      }
      keys.add(task.key);
      for (const dependency of task.depends_on) {
        if (!plan.tasks.some((candidate) => candidate.key === dependency)) {
          throw new Error(
            `Task ${task.key} depends on unknown key: ${dependency}`,
          );
        }
      }
    }
    this.assertAcyclic(plan.tasks);

    const existingThread = plan.thread_id
      ? this.store.getThread(plan.thread_id)
      : null;
    if (plan.thread_id && !existingThread) {
      throw new Error(`Thread not found: ${plan.thread_id}`);
    }

    const now = nowIso();
    const thread =
      existingThread ??
      this.store.createThread({
        id: newId("th"),
        company_id: MAIN_COMPANY_ID,
        title: plan.title,
        goal: plan.goal,
        status: "active",
        summary: "",
        created_at: now,
        updated_at: now,
      });

    const created: Task[] = [];
    const edges: Array<{ task_id: string; depends_on: string }> = [];
    this.store.transaction(() => {
      for (const inputTask of plan.tasks) {
        const task: Task = {
          id: newId("t"),
          company_id: MAIN_COMPANY_ID,
          thread_id: thread.id,
          parent_task_id: null,
          task_key: inputTask.key,
          title: inputTask.title,
          objective: inputTask.objective,
          assignee: inputTask.assignee ?? null,
          status: "queued",
          priority: inputTask.priority,
          acceptance: inputTask.acceptance,
          constraints: inputTask.constraints ?? {},
          inputs: [],
          budget: inputTask.budget ?? {},
          deadline: inputTask.deadline ?? null,
          attempts: 0,
          max_retries: inputTask.max_retries ?? 0,
          lease_owner: null,
          lease_expires_at: null,
          lease_token: null,
          created_at: now,
          updated_at: now,
        };
        this.store.insertTask(task);
        created.push(task);
      }
      for (const inputTask of plan.tasks) {
        const task = created.find((candidate) => candidate.task_key === inputTask.key);
        if (!task) throw new Error(`Task creation failed: ${inputTask.key}`);
        for (const dependency of inputTask.depends_on) {
          const dependencyTask = created.find(
            (candidate) => candidate.task_key === dependency,
          );
          if (!dependencyTask) throw new Error(`Dependency not found: ${dependency}`);
          this.store.addTaskEdge(task.id, dependencyTask.id);
          edges.push({ task_id: task.id, depends_on: dependencyTask.id });
        }
      }
    });

    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: null,
      seq: undefined,
      type: "plan.created",
      payload: {
        thread_id: thread.id,
        task_count: created.length,
        tasks: created.map((task) => task.id),
      },
      created_at: nowIso(),
    });

    return { thread, tasks: created, edges };
  }

  private assertAcyclic(tasks: CreatePlanInput["tasks"]): void {
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      if (visiting.has(key)) {
        throw new Error(`Task graph contains a cycle at: ${key}`);
      }
      visiting.add(key);
      const task = byKey.get(key);
      if (!task) throw new Error(`Unknown task key: ${key}`);
      for (const dependency of task.depends_on) {
        visit(dependency);
      }
      visiting.delete(key);
      visited.add(key);
    };
    for (const task of tasks) visit(task.key);
  }

  // ---------- assignment / execution ----------

  assignTask(taskId: string, positionName?: string): Task {
    const task = this.requireTask(taskId);
    if (isTerminal(task.status)) {
      throw new Error(`Task ${taskId} is ${task.status} and cannot be assigned`);
    }
    const name = positionName ?? task.assignee;
    if (!name) throw new Error(`Task ${taskId} has no assignee`);
    const position = this.store.getPositionByName(name);
    if (!position) throw new Error(`Position not found: ${name}`);
    if (position.status === "fired" || position.status === "paused") {
      throw new Error(`Position ${name} is ${position.status}`);
    }
    if (task.status === "queued") {
      this.store.updateTaskStatus(task.id, "assigned");
    }
    this.store.updateTaskAssignee(task.id, position.name);
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "task.assigned",
      payload: { position: position.name },
      created_at: nowIso(),
    });
    return this.maybeRequestApproval(this.requireTask(task.id));
  }

  private maybeRequestApproval(task: Task): Task {
    if (
      task.constraints.requires_approval !== true ||
      task.constraints.approval_resolved === true
    ) {
      return task;
    }
    const question =
      typeof task.constraints.approval_question === "string"
        ? task.constraints.approval_question
        : `是否批准执行「${task.title}」？`;
    const options = Array.isArray(task.constraints.approval_options)
      ? (task.constraints.approval_options as unknown[]).map(String)
      : ["批准", "拒绝"];
    this.requestDecision({
      task_id: task.id,
      question,
      options,
    });
    return this.requireTask(task.id);
  }

  assignAll(threadId?: string): Task[] {
    const tasks = this.store
      .listTasks(MAIN_COMPANY_ID, threadId)
      .filter((task) => task.assignee && task.status === "queued");
    return tasks.map((task) => this.assignTask(task.id));
  }

  async runReady(threadId?: string): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const tasks = this.store
        .listTasks(MAIN_COMPANY_ID, threadId)
        .filter((task) => task.status === "assigned")
        .filter((task) => this.store.dependenciesDone(task.id))
        .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
      if (tasks.length === 0) break;
      for (const task of tasks) {
        results.push(await this.executeTask(task));
      }
    }
    return results;
  }

  private async executeTask(task: Task, instruction?: string): Promise<ExecutionResult> {
    const position = this.positionForTask(task);
    if (position.status === "busy") {
      throw new Error(`Position ${position.name} is busy`);
    }
    this.assertBudget(task, position);
    if (position.node_id !== LOCAL_NODE_ID) {
      return this.executeRemoteTask(task, position, instruction);
    }
    if (task.status === "queued") {
      this.store.updateTaskStatus(task.id, "assigned");
      task = this.requireTask(task.id);
    }
    assertTransition(task.status, "running");

    const adapter = this.adapterFor(position);
    const workspace = this.prepareWorkspace(position, task);
    const { pack, contextPackId } = this.contextPack(
      task,
      position,
      workspace,
      instruction,
    );
    const runId = newId("r");
    const timeoutMs = this.timeoutForTask(task);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    timer.unref?.();

    this.store.createRun({
      id: runId,
      task_id: task.id,
      position_id: position.id,
      status: "running",
      session_ref: null,
      context_pack_id: contextPackId,
      node_id: LOCAL_NODE_ID,
      lease_token: null,
      started_at: nowIso(),
      ended_at: null,
      cost: {},
      tokens: 0,
      cost_usd: 0,
    });
    this.store.updateTaskStatus(task.id, "running");
    this.store.updatePositionStatus(position.id, "busy");
    this.recordRunEvent(runId, task.id, "run.started", {
      position: position.name,
      adapter: adapter.kind,
      context_pack_id: contextPackId,
      cwd: workspace.cwd,
      resumed: Boolean(pack.session_ref),
    });

    const runInput: RunInput = {
      run_id: runId,
      task: this.requireTask(task.id),
      position,
      context: pack,
      cwd: workspace.cwd,
      instruction: instruction?.trim() || task.objective,
      timeout_ms: timeoutMs,
      signal: abortController.signal,
      approval_handler: (request) =>
        this.handleToolApproval(task, position, request),
    };
    const eventSink = (event: HarnessEvent): void => {
      this.recordHarnessEvent(runId, task.id, event);
    };

    let result: HarnessRunResult;
    if (task.constraints.integration === true) {
      try {
        result = this.runIntegration(task, workspace, runInput, runId, eventSink);
      } finally {
        clearTimeout(timer);
      }
    } else {
      try {
        const session = this.usableSession(position, adapter, workspace);
        if (session?.session_id && adapter.resume) {
          try {
            result = await adapter.resume(session.session_id, runInput, eventSink);
          } catch (error) {
            if (!(error instanceof SessionExpiredError)) throw error;
            this.recordRunEvent(runId, task.id, "session.fallback", {
              session_id: session.session_id,
              reason: error.message,
            });
            result = await adapter.start(runInput, eventSink);
          }
        } else {
          result = await adapter.start(runInput, eventSink);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.recordHarnessEvent(runId, task.id, {
          type: "error",
          message,
        });
        result = {
          report: reportFor(runInput, "failed", `${adapter.kind} 执行失败：${message}`, {
            risks: [message],
            next: ["由 CEO 决定重试或转派"],
          }),
          events: [{ type: "error", message }],
          usage: {},
          exit_code: null,
          stderr: message,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const test =
      result.report.status === "done"
        ? this.runTestCommand(task, workspace.cwd)
        : null;
    let finalized: WorkspaceResult;
    try {
      finalized = this.workspaceManager.finalize(workspace, task, runId);
    } catch (error) {
      finalized = {
        changes: [],
        changed_files: [],
        diff_path: null,
        diff: "",
      };
      result.report.risks.push(
        `工作区收尾失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const enriched = this.enrichReport(
      result,
      task,
      workspace,
      finalized,
      test,
      runId,
    );
    const validated = ReportSchema.parse(enriched);

    this.store.insertReport({
      id: newId("rep"),
      task_id: task.id,
      run_id: runId,
      status: validated.status,
      summary: validated.summary,
      report: validated,
      created_at: nowIso(),
    });

    const nextStatus = this.reportToTaskStatus(validated.status);
    this.store.updateTaskStatus(task.id, nextStatus);
    this.store.updatePositionStatus(position.id, "idle");
    this.store.updateRun(runId, {
      status: validated.status === "failed" ? "failed" : "done",
      ended_at: nowIso(),
      cost: {
        tokens: result.usage?.tokens ?? 0,
        usd: result.usage?.cost_usd ?? 0,
      },
      tokens: result.usage?.tokens ?? 0,
      cost_usd: result.usage?.cost_usd ?? 0,
      session_ref: result.session_id ?? null,
    });
    this.enforceTaskBudget(task, runId);
    this.markReviewReady(task, validated);
    this.maybeAutoRetry(task, validated, position);

    if (validated.status === "needs_decision" && validated.decision) {
      this.store.insertDecision({
        id: newId("d"),
        company_id: MAIN_COMPANY_ID,
        thread_id: task.thread_id,
        task_id: task.id,
        question: validated.decision.question,
        options: validated.decision.options,
        status: "open",
        chosen: null,
        rationale: null,
        created_at: nowIso(),
        resolved_at: null,
      });
    }

    const existingSession = this.store.getSessionRef(position.id);
    const sessionId =
      result.session_id ?? existingSession?.session_id ?? undefined;
    if (sessionId) {
      this.store.upsertSessionRef({
        id: existingSession?.id ?? newId("s"),
        position_id: position.id,
        harness_kind: adapter.kind,
        session_id: sessionId,
        cwd: workspace.cwd,
        model: position.model,
        harness_version: `m1:${adapter.kind}`,
        context_hash: pack.context_hash,
        last_used_at: nowIso(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: "active",
      });
    }

    this.store.upsertMemory(position.id, "last_task", {
      task_id: task.id,
      title: task.title,
      status: validated.status,
      run_id: runId,
    });
    this.store.upsertMemory(position.id, "last_handoff", validated.handoff);

    for (const evidence of validated.evidence) {
      if (
        typeof evidence === "object" &&
        evidence !== null &&
        "artifact" in evidence
      ) {
        const artifact = (evidence as { artifact?: unknown }).artifact;
        if (typeof artifact === "string") {
          this.store.insertArtifact({
            id: newId("art"),
            task_id: task.id,
            run_id: runId,
            kind:
              typeof (evidence as { kind?: unknown }).kind === "string"
                ? String((evidence as { kind: string }).kind)
                : "evidence",
            uri: artifact,
            sha256: null,
            meta: {},
            created_at: nowIso(),
          });
        }
      }
    }

    const thread = this.store.getThread(task.thread_id);
    if (thread) {
      this.store.updateThreadSummary(
        thread.id,
        `${thread.title}：${validated.summary}`,
      );
    }

    this.recordRunEvent(runId, task.id, "run.finished", {
      status: validated.status,
      summary: validated.summary,
      session_id: sessionId ?? null,
      tokens: result.usage?.tokens ?? 0,
      cost_usd: result.usage?.cost_usd ?? 0,
    });

    return {
      task: this.requireTask(task.id),
      position: this.requirePosition(position.id),
      report: validated,
      run_id: runId,
    };
  }

  private runIntegration(
    task: Task,
    workspace: PreparedWorkspace,
    runInput: RunInput,
    runId: string,
    onEvent: (event: HarnessEvent) => void,
  ): HarnessRunResult {
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent(event);
    };
    if (!workspace.is_git) {
      return {
        report: reportFor(
          runInput,
          "failed",
          "集成任务需要 git 仓库和 worktree；当前 workspace 不是 git 仓库。",
          { risks: ["integration requires git"], next: ["改为 git 仓库后重试"] },
        ),
        events,
        usage: {},
        exit_code: 1,
        stderr: "integration requires git",
      };
    }

    const explicit = Array.isArray(
      task.constraints.integration_source_task_ids,
    )
      ? new Set(
          (task.constraints.integration_source_task_ids as unknown[]).map(String),
        )
      : null;
    const candidates = this.store
      .listTasks(MAIN_COMPANY_ID, task.thread_id)
      .filter(
        (candidate) =>
          candidate.id !== task.id &&
          candidate.status === "done" &&
          candidate.constraints.integration !== true &&
          (!explicit || explicit.has(candidate.id)),
      );
    const merged: Array<{
      task_id: string;
      title: string;
      commit: string;
    }> = [];
    const skipped: Array<{ task_id: string; title: string; reason: string }> =
      [];

    for (const source of candidates) {
      const report = this.store.getLatestReportForTask(source.id);
      if (!report) {
        skipped.push({
          task_id: source.id,
          title: source.title,
          reason: "no report",
        });
        continue;
      }
      const changes = Array.isArray(report.report.changes)
        ? (report.report.changes as Array<Record<string, unknown>>)
        : [];
      const change = changes.find(
        (entry) =>
          typeof entry.repo === "string" &&
          typeof entry.commit === "string" &&
          resolve(entry.repo) === resolve(workspace.repo),
      );
      if (!change || typeof change.commit !== "string") {
        skipped.push({
          task_id: source.id,
          title: source.title,
          reason: "no commit in the integration repo",
        });
        continue;
      }
      if (merged.some((entry) => entry.commit === change.commit)) continue;
      const merge = spawnSync(
        "git",
        ["merge", "--no-ff", "--no-edit", change.commit],
        {
          cwd: workspace.cwd,
          encoding: "utf8",
          windowsHide: true,
          timeout: 60_000,
        },
      );
      if (merge.status !== 0) {
        const conflicts = spawnSync(
          "git",
          ["diff", "--name-only", "--diff-filter=U"],
          { cwd: workspace.cwd, encoding: "utf8", windowsHide: true },
        );
        spawnSync("git", ["merge", "--abort"], {
          cwd: workspace.cwd,
          encoding: "utf8",
          windowsHide: true,
        });
        const files = (conflicts.stdout ?? "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const message = [
          `集成任务 ${task.title} 合并 ${source.title} (${change.commit.slice(0, 8)}) 冲突。`,
          files.length > 0 ? `冲突文件：${files.join(", ")}` : "",
          (merge.stderr || merge.stdout || "").trim(),
        ]
          .filter(Boolean)
          .join("\n");
        emit({ type: "error", message });
        return {
          report: reportFor(runInput, "failed", message, {
            evidence: [
              {
                kind: "integration",
                git_merge: "conflict",
                source_task_id: source.id,
                commit: change.commit,
                conflict_files: files,
              },
            ],
            risks: ["合并冲突"],
            next: ["由 CEO 指定冲突处理人，或改用 base_ref/串行依赖"],
          }),
          events,
          usage: {},
          exit_code: 1,
          stderr: message,
        };
      }
      merged.push({
        task_id: source.id,
        title: source.title,
        commit: change.commit,
      });
      emit({
        type: "status",
        status: "merged",
        message: `${source.title} → ${change.commit.slice(0, 8)}`,
      });
    }

    if (merged.length === 0) {
      const message =
        "没有可合并的已完成任务分支；集成任务至少需要一个带 commit 的 source task。";
      return {
        report: reportFor(runInput, "failed", message, {
          risks: ["no source branches"],
          next: ["先完成依赖任务，或指定 integration_source_task_ids"],
        }),
        events,
        usage: {},
        exit_code: 1,
        stderr: message,
      };
    }

    const head = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.cwd,
      encoding: "utf8",
      windowsHide: true,
    });
    const summary = [
      `已集成 ${merged.length} 个任务到 ${workspace.branch}。`,
      ...merged.map((entry) => `- ${entry.title} (${entry.commit.slice(0, 8)})`),
      skipped.length > 0
        ? `跳过：${skipped.map((entry) => `${entry.title}（${entry.reason}）`).join("、")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      report: reportFor(runInput, "done", summary, {
        evidence: [
          {
            kind: "integration",
            branch: workspace.branch,
            head: head.status === 0 ? head.stdout.trim() : null,
            merged,
            skipped,
          },
        ],
        next: ["运行集成测试；通过后进入 merge queue"],
      }),
      events,
      usage: {},
      exit_code: 0,
    };
  }

  private async executeRemoteTask(
    task: Task,
    position: Position,
    instruction?: string,
  ): Promise<ExecutionResult> {
    const node = this.store.getNode(position.node_id);
    if (!node) throw new Error(`Node not found: ${position.node_id}`);
    if (node.revoked_at) throw new Error(`Node ${node.name} is revoked`);
    if (node.drain) throw new Error(`Node ${node.name} is draining`);
    if (!this.nodeIsOnline(node)) {
      throw new Error(
        `Node ${node.name} is offline (last seen ${node.last_seen_at})`,
      );
    }

    this.store.updateTaskStatus(task.id, "assigned");
    task = this.requireTask(task.id);
    const workspace: PreparedWorkspace = {
      cwd: position.workspace,
      repo: position.workspace,
      branch: `task/${task.id}`,
      base_ref:
        typeof task.constraints.base_ref === "string"
          ? task.constraints.base_ref
          : "",
      is_git: position.harness_kind !== "fake",
    };
    const { pack, contextPackId } = this.contextPack(
      task,
      position,
      workspace,
      instruction,
    );
    const runId = newId("r");
    this.store.createRun({
      id: runId,
      task_id: task.id,
      position_id: position.id,
      status: "dispatched",
      session_ref: null,
      context_pack_id: contextPackId,
      node_id: node.id,
      lease_token: null,
      started_at: nowIso(),
      ended_at: null,
      cost: {},
      tokens: 0,
      cost_usd: 0,
    });
    this.store.updatePositionStatus(position.id, "busy");
    this.recordRunEvent(runId, task.id, "remote.dispatched", {
      node_id: node.id,
      node_name: node.name,
      position: position.name,
      context_pack_id: contextPackId,
    });

    const deadline = Date.now() + this.remoteWaitMs;
    let current = this.requireTask(task.id);
    while (Date.now() < deadline) {
      this.releaseExpiredLeases();
      current = this.requireTask(task.id);
      if (isTerminal(current.status)) break;
      await sleep(100);
    }

    if (!isTerminal(current.status)) {
      this.store.clearTaskLease(task.id);
      this.store.updateTaskStatus(task.id, "assigned");
      this.store.updatePositionStatus(position.id, "idle");
      this.store.updateRun(runId, {
        status: "timed_out",
        ended_at: nowIso(),
      });
      this.recordRunEvent(runId, task.id, "remote.timeout", {
        node_id: node.id,
        wait_ms: this.remoteWaitMs,
      });
      throw new Error(
        `Remote task ${task.id} timed out waiting for node ${node.name}`,
      );
    }

    const report = this.store.getLatestReportForTask(task.id)?.report;
    if (!report) {
      this.store.updatePositionStatus(position.id, "idle");
      throw new Error(`Remote task ${task.id} ended without a report`);
    }
    this.store.updatePositionStatus(position.id, "idle");
    this.store.updateRun(runId, {
      status: report.status === "failed" ? "failed" : "done",
      ended_at: nowIso(),
    });
    return {
      task: this.requireTask(task.id),
      position: this.requirePosition(position.id),
      report,
      run_id: runId,
    };
  }

  async continueTask(taskId: string, instruction: string): Promise<ExecutionResult> {
    const task = this.requireTask(taskId);
    if (task.status === "cancelled") {
      throw new Error("Cannot continue a cancelled task");
    }
    if (task.status === "waiting_approval") {
      throw new Error("Resolve the open decision before continuing");
    }
    if (task.status === "queued" || task.status === "assigned") {
      this.assignTask(task.id);
      return this.executeTask(this.requireTask(task.id), instruction);
    }
    if (task.status === "blocked" || task.status === "failed") {
      this.store.updateTaskStatus(task.id, "queued");
      this.assignTask(task.id);
      return this.executeTask(this.requireTask(task.id), instruction);
    }
    return this.executeTask(task, instruction);
  }

  async reopenTask(taskId: string, reason: string): Promise<ExecutionResult> {
    const task = this.requireTask(taskId);
    if (task.status === "cancelled") {
      throw new Error("Cannot reopen a cancelled task");
    }
    if (task.status === "done") {
      return this.executeTask(task, `返工原因：${reason}`);
    }
    if (task.status === "blocked" || task.status === "failed") {
      this.store.updateTaskStatus(task.id, "queued");
      this.assignTask(task.id);
      return this.executeTask(this.requireTask(task.id), `返工原因：${reason}`);
    }
    return this.continueTask(task.id, `返工原因：${reason}`);
  }

  async waitForTask(taskId: string, timeoutMs = 30_000): Promise<Task> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const task = this.requireTask(taskId);
      if (isTerminal(task.status)) return task;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for task ${taskId}`);
  }

  cancelTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status === "cancelled") return task;
    assertTransition(task.status, "cancelled");
    this.store.updateTaskStatus(task.id, "cancelled");
    if (task.assignee) {
      const position = this.store.getPositionByName(task.assignee);
      if (position) {
        this.store.updatePositionStatus(position.id, "idle");
      }
    }
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "task.cancelled",
      payload: {},
      created_at: nowIso(),
    });
    return this.requireTask(task.id);
  }

  // ---------- decisions ----------

  requestDecision(input: DecisionRequestInput): Decision {
    const parsed = DecisionRequestInputSchema.parse(input);
    const task = this.requireTask(parsed.task_id);
    const decision: Decision = {
      id: newId("d"),
      company_id: MAIN_COMPANY_ID,
      thread_id: task.thread_id,
      task_id: task.id,
      question: parsed.question,
      options: parsed.options,
      status: "open",
      chosen: null,
      rationale: null,
      created_at: nowIso(),
      resolved_at: null,
    };
    this.store.insertDecision(decision);
    if (!isTerminal(task.status) && task.status !== "waiting_approval") {
      assertTransition(task.status, "waiting_approval");
      this.store.updateTaskStatus(task.id, "waiting_approval");
    }
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "decision.requested",
      payload: { decision_id: decision.id, question: decision.question },
      created_at: nowIso(),
    });
    return decision;
  }

  resolveDecision(
    decisionId: string,
    chosen: string,
    rationale: string | null = null,
  ): Decision {
    const decision = this.store.getDecision(decisionId);
    if (!decision) throw new Error(`Decision not found: ${decisionId}`);
    if (decision.status !== "open") {
      throw new Error(`Decision ${decisionId} is already ${decision.status}`);
    }
    this.store.resolveDecision(decision.id, chosen, rationale);
    if (decision.task_id) {
      const task = this.store.getTask(decision.task_id);
      if (task) {
        const rejected = /reject|拒绝|取消/i.test(chosen);
        this.store.updateTaskConstraints(task.id, {
          ...task.constraints,
          approval_resolved: true,
          approval_choice: chosen,
        });
        if (task.status === "waiting_approval") {
          this.store.updateTaskStatus(
            task.id,
            rejected ? "cancelled" : "assigned",
          );
        }
        this.store.insertEvent({
          id: newId("e"),
          run_id: null,
          task_id: task.id,
          type: "decision.resolved",
          payload: { decision_id: decision.id, chosen, rationale },
          created_at: nowIso(),
        });
      }
    }
    return this.store.getDecision(decisionId) as Decision;
  }

  // ---------- positions ----------

  hirePosition(input: HirePositionInput): Position {
    const parsed = HirePositionInputSchema.parse(input);
    if (this.store.getPositionByName(parsed.name)) {
      throw new Error(`Position already exists: ${parsed.name}`);
    }
    const nodeId = parsed.node_id ?? LOCAL_NODE_ID;
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);
    const workspace =
      parsed.workspace ??
      (node.kind === "remote"
        ? join("workspace", parsed.name)
        : join(process.cwd(), ".aic", "workspaces", parsed.name));
    if (node.kind !== "remote") {
      mkdirSync(workspace, { recursive: true });
    }
    const position: Position = {
      id: newId("p"),
      company_id: MAIN_COMPANY_ID,
      node_id: nodeId,
      name: parsed.name,
      role: parsed.role,
      harness_kind: parsed.harness_kind,
      model: parsed.model ?? null,
      status: "idle",
      workspace,
      policy: DEFAULT_POLICY,
      budget: parsed.budget ?? { usd: 5, minutes: 60 },
      created_at: nowIso(),
    };
    this.store.insertPosition(position);
    this.store.upsertMemory(position.id, "playbook", {
      role: position.role,
      harness_kind: position.harness_kind,
      rules: [
        "只执行任务单描述的工作",
        "完成后提交结构化报告和交接单",
        "不要直接联系人类",
      ],
    });
    return position;
  }

  pausePosition(name: string): Position {
    const position = this.requirePositionByName(name);
    this.store.updatePositionStatus(position.id, "paused");
    return this.requirePositionByName(name);
  }

  firePosition(name: string): Position {
    const position = this.requirePositionByName(name);
    this.store.updatePositionStatus(position.id, "fired");
    return this.requirePositionByName(name);
  }

  nodeList(): Array<Record<string, unknown>> {
    const tasks = this.store.listTasks();
    return this.store.listNodes().map((node) => {
      const positions = this.store
        .listPositions()
        .filter((position) => position.node_id === node.id);
      const names = new Set(positions.map((position) => position.name));
      return {
        ...node,
        online: this.nodeIsOnline(node),
        positions: positions.map((position) => ({
          name: position.name,
          role: position.role,
          harness_kind: position.harness_kind,
          status: position.status,
        })),
        active_tasks: tasks
          .filter(
            (task) =>
              task.assignee &&
              names.has(task.assignee) &&
              ["assigned", "running", "waiting_input", "waiting_approval"].includes(
                task.status,
              ),
          )
          .map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            lease_expires_at: task.lease_expires_at,
          })),
      };
    });
  }

  // ---------- multi-node ----------

  createEnrollmentToken(name?: string): { token: string; expires_at: string } {
    const token = `aic_enroll_${randomBytes(24).toString("hex")}`;
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    this.store.insertEnrollmentToken({
      id: newId("enr"),
      company_id: MAIN_COMPANY_ID,
      token_hash: this.hashToken(token),
      name: name ?? null,
      created_at: nowIso(),
      expires_at: expiresAt,
    });
    return { token, expires_at: expiresAt };
  }

  registerNode(input: NodeRegistrationRequest): {
    node_id: string;
    token: string;
    name: string;
    server_time: string;
  } {
    if (!input.name?.trim()) throw new Error("Node name is required");
    if (!input.workspace_root?.trim()) {
      throw new Error("Node workspace_root is required");
    }
    if (this.store.getNodeByName(input.name)) {
      throw new Error(`Node name already exists: ${input.name}`);
    }
    const nodeId = newId("n");
    const enrollment = this.store.consumeEnrollmentToken(
      this.hashToken(input.token),
      nodeId,
    );
    if (!enrollment) {
      throw new Error("Invalid, expired or already-used enrollment token");
    }
    const nodeToken = `aic_node_${randomBytes(32).toString("hex")}`;
    const node: Node = {
      id: nodeId,
      company_id: MAIN_COMPANY_ID,
      name: input.name,
      os: input.os ?? "unknown",
      status: "online",
      capabilities: input.capabilities ?? {},
      last_seen_at: nowIso(),
      kind: "remote",
      workspace_root: input.workspace_root,
      drain: false,
      revoked_at: null,
      registered_at: nowIso(),
    };
    this.store.insertRemoteNode(node, this.hashToken(nodeToken));
    return {
      node_id: node.id,
      token: nodeToken,
      name: node.name,
      server_time: nowIso(),
    };
  }

  heartbeatNode(
    token: string,
    capabilities?: Record<string, unknown>,
  ): { drain: boolean; revoked: boolean; server_time: string } {
    const node = this.authenticateNode(token);
    this.store.updateNodeHeartbeat(node.id, capabilities);
    const fresh = this.requireNode(node.id);
    return {
      drain: fresh.drain,
      revoked: Boolean(fresh.revoked_at),
      server_time: nowIso(),
    };
  }

  claimTaskForNode(
    token: string,
    leaseMs = 60_000,
  ): { task: NodeTaskPayload | null } {
    const node = this.authenticateNode(token);
    if (node.drain || node.revoked_at) return { task: null };
    this.releaseExpiredLeases();

    for (const task of this.store.listTasksAssignedToNode(node.id)) {
      if (!this.store.dependenciesDone(task.id)) continue;
      const leaseToken = `lease_${randomBytes(18).toString("hex")}`;
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      const claimed = this.store.claimTaskForNode(
        task.id,
        node.id,
        leaseToken,
        expiresAt,
      );
      if (!claimed) continue;
      const position = this.requirePositionByName(claimed.assignee ?? "");
      let run = this.store.getLatestRunForTask(claimed.id);
      if (!run) {
        throw new Error(`No dispatched run for task ${claimed.id}`);
      }
      this.store.updateRun(run.id, {
        status: "running",
        node_id: node.id,
        lease_token: leaseToken,
      });
      const context = run.context_pack_id
        ? (this.store.getContextPack(run.context_pack_id) as ContextPack | null)
        : null;
      if (!context) {
        throw new Error(`Context pack missing for task ${claimed.id}`);
      }
      this.recordRunEvent(run.id, claimed.id, "remote.claimed", {
        node_id: node.id,
        lease_token: leaseToken,
        expires_at: expiresAt,
      });
      return {
        task: {
          run_id: run.id,
          task: claimed,
          position,
          context,
          lease_token: leaseToken,
          expires_at: expiresAt,
        },
      };
    }
    return { task: null };
  }

  renewNodeLease(
    token: string,
    runId: string,
    leaseToken: string,
    leaseMs = 60_000,
  ): { expires_at: string; server_time: string } {
    const node = this.authenticateNode(token);
    const run = this.store.getRun(runId);
    if (!run || run.node_id !== node.id) {
      throw new Error("Run does not belong to this node");
    }
    const task = this.requireTask(run.task_id);
    if (task.lease_token !== leaseToken) {
      throw new Error("Lease token mismatch");
    }
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    if (!this.store.renewTaskLease(task.id, leaseToken, expiresAt)) {
      throw new Error("Lease is no longer active");
    }
    this.store.updateNodeHeartbeat(node.id);
    return { expires_at: expiresAt, server_time: nowIso() };
  }

  recordNodeEvents(token: string, batch: NodeEventBatch): { ok: true } {
    const node = this.authenticateNode(token);
    const run = this.store.getRun(batch.run_id);
    if (!run || run.node_id !== node.id) {
      throw new Error("Run does not belong to this node");
    }
    for (const event of batch.events) {
      this.recordHarnessEvent(run.id, run.task_id, event);
    }
    return { ok: true };
  }

  completeNodeTask(token: string, completion: NodeCompletion): {
    ok: true;
    task_id: string;
    status: Report["status"];
  } {
    const node = this.authenticateNode(token);
    const run = this.store.getRun(completion.run_id);
    if (!run || run.node_id !== node.id) {
      throw new Error("Run does not belong to this node");
    }
    const task = this.requireTask(run.task_id);
    if (
      task.lease_token &&
      completion.lease_token &&
      task.lease_token !== completion.lease_token
    ) {
      throw new Error("Lease token mismatch");
    }
    const position = this.requirePosition(run.position_id);
    const context = run.context_pack_id
      ? (this.store.getContextPack(run.context_pack_id) as ContextPack | null)
      : null;

    const report = ReportSchema.parse(completion.report);
    const evidence = [...report.evidence];
    for (const artifact of completion.artifacts ?? []) {
      const filename = `${completion.run_id}-${artifact.filename}`.replaceAll(
        /[^a-zA-Z0-9._-]/g,
        "-",
      );
      const artifactDir = join(process.cwd(), ".aic", "artifacts");
      mkdirSync(artifactDir, { recursive: true });
      const path = join(artifactDir, `remote-${filename}`);
      writeFileSync(
        path,
        artifact.encoding === "base64"
          ? Buffer.from(artifact.content, "base64")
          : artifact.content,
        artifact.encoding === "base64" ? undefined : "utf8",
      );
      this.store.insertArtifact({
        id: newId("art"),
        task_id: task.id,
        run_id: run.id,
        kind: artifact.kind,
        uri: path,
        sha256: null,
        meta: { source: "remote", node_id: node.id },
        created_at: nowIso(),
      });
      evidence.push({ kind: artifact.kind, artifact: path });
    }
    const finalReport = ReportSchema.parse({
      ...report,
      evidence,
    });

    this.store.insertReport({
      id: newId("rep"),
      task_id: task.id,
      run_id: run.id,
      status: finalReport.status,
      summary: finalReport.summary,
      report: finalReport,
      created_at: nowIso(),
    });
    this.store.updateTaskStatus(
      task.id,
      this.reportToTaskStatus(finalReport.status),
    );
    this.store.updatePositionStatus(position.id, "idle");
    this.store.updateRun(run.id, {
      status: finalReport.status === "failed" ? "failed" : "done",
      ended_at: nowIso(),
      cost: {
        tokens: completion.usage?.tokens ?? 0,
        usd: completion.usage?.cost_usd ?? 0,
      },
      tokens: completion.usage?.tokens ?? 0,
      cost_usd: completion.usage?.cost_usd ?? 0,
      session_ref: completion.session_id ?? null,
    });
    this.store.clearTaskLease(task.id);
    this.enforceTaskBudget(task, run.id);
    this.markReviewReady(task, finalReport);

    if (finalReport.status === "needs_decision" && finalReport.decision) {
      this.store.insertDecision({
        id: newId("d"),
        company_id: MAIN_COMPANY_ID,
        thread_id: task.thread_id,
        task_id: task.id,
        question: finalReport.decision.question,
        options: finalReport.decision.options,
        status: "open",
        chosen: null,
        rationale: null,
        created_at: nowIso(),
        resolved_at: null,
      });
    }

    if (completion.session_id) {
      const existing = this.store.getSessionRef(position.id);
      const ctxWorkspace =
        context && typeof context.workspace === "object" && context.workspace
          ? (context.workspace as { path?: unknown }).path
          : undefined;
      this.store.upsertSessionRef({
        id: existing?.id ?? newId("s"),
        position_id: position.id,
        harness_kind: position.harness_kind,
        session_id: completion.session_id,
        cwd:
          typeof ctxWorkspace === "string"
            ? ctxWorkspace
            : position.workspace,
        model: position.model,
        harness_version: `m2:${position.harness_kind}`,
        context_hash:
          context?.context_hash ?? "remote",
        last_used_at: nowIso(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: "active",
      });
    }

    this.store.upsertMemory(position.id, "last_task", {
      task_id: task.id,
      title: task.title,
      status: finalReport.status,
      run_id: run.id,
    });
    this.store.upsertMemory(position.id, "last_handoff", finalReport.handoff);
    const thread = this.store.getThread(task.thread_id);
    if (thread) {
      this.store.updateThreadSummary(
        thread.id,
        `${thread.title}：${finalReport.summary}`,
      );
    }
    this.recordRunEvent(run.id, task.id, "remote.completed", {
      node_id: node.id,
      status: finalReport.status,
      session_id: completion.session_id ?? null,
    });

    return {
      ok: true,
      task_id: task.id,
      status: finalReport.status,
    };
  }

  releaseExpiredLeases(): Task[] {
    const expired = this.store.listExpiredLeases();
    for (const task of expired) {
      this.store.clearTaskLease(task.id);
      this.store.updateTaskStatus(task.id, "assigned");
      if (task.assignee) {
        const position = this.store.getPositionByName(task.assignee);
        if (position) {
          this.store.updatePositionStatus(position.id, "idle");
        }
      }
      const run = this.store.getLatestRunForTask(task.id);
      if (run) {
        this.store.updateRun(run.id, {
          status: "dispatched",
          ended_at: nowIso(),
          lease_token: null,
        });
        this.recordRunEvent(run.id, task.id, "lease.expired", {
          previous_owner: task.lease_owner,
          previous_expires_at: task.lease_expires_at,
        });
      }
    }
    return expired;
  }

  // ---------- budgets, retries, metrics, memory, merge queue ----------

  backupTo(path: string): void {
    this.store.backupTo(path);
  }

  pruneLogs(maxAgeDays = 7): { removed: number } {
    const dir = join(process.cwd(), ".aic", "logs");
    if (!existsSync(dir)) return { removed: 0 };
    const cutoff = Date.now() - Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).mtimeMs < cutoff) {
          unlinkSync(path);
          removed += 1;
        }
      } catch {
        // best-effort maintenance
      }
    }
    return { removed };
  }

  budgetStatus(): Record<string, unknown> {
    const company = this.requireCompany();
    const companyLimit = this.numberBudget(company.budget.usd);
    const companySpend = this.store.companySpend();
    const companyMinutesLimit = this.numberBudget(company.budget.minutes);
    const companyMinutes = this.store.companyMinutes();
    return {
      company: {
        budget_usd: companyLimit,
        spent_usd: companySpend,
        remaining_usd:
          companyLimit === null ? null : Math.max(0, companyLimit - companySpend),
        budget_minutes: companyMinutesLimit,
        spent_minutes: companyMinutes,
        remaining_minutes:
          companyMinutesLimit === null
            ? null
            : Math.max(0, companyMinutesLimit - companyMinutes),
      },
      positions: this.store.listPositions().map((position) => {
        const limit = this.numberBudget(position.budget.usd);
        const spent = this.store.positionSpend(position.id);
        const minuteLimit = this.numberBudget(position.budget.minutes);
        const minutes = this.store.positionMinutes(position.id);
        return {
          name: position.name,
          budget_usd: limit,
          spent_usd: spent,
          remaining_usd: limit === null ? null : Math.max(0, limit - spent),
          budget_minutes: minuteLimit,
          spent_minutes: minutes,
          remaining_minutes:
            minuteLimit === null
              ? null
              : Math.max(0, minuteLimit - minutes),
        };
      }),
    };
  }

  setCompanyBudget(usd: number, minutes?: number): Record<string, unknown> {
    const company = this.requireCompany();
    const budget = {
      ...company.budget,
      usd,
      ...(minutes !== undefined ? { minutes } : {}),
    };
    this.store.updateCompanyBudget(company.id, budget);
    return budget;
  }

  setPositionBudget(name: string, usd: number): Record<string, unknown> {
    const position = this.requirePositionByName(name);
    const budget = { ...position.budget, usd };
    this.store.updatePositionBudget(position.id, budget);
    return budget;
  }

  retryTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== "failed" && task.status !== "blocked") {
      throw new Error(`Task ${taskId} is ${task.status}, not retryable`);
    }
    this.store.resetTaskForRetry(task.id);
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "task.retry.manual",
      payload: { attempts: task.attempts },
      created_at: nowIso(),
    });
    return this.requireTask(task.id);
  }

  metrics(): Record<string, unknown> {
    const tasks = this.store.listTasks();
    const runs = this.store.listRunsForCompany();
    const byStatus = countByStatus(tasks);
    const finished = runs.filter((run) => run.ended_at);
    const avgDuration =
      finished.length === 0
        ? 0
        : finished.reduce((sum, run) => {
            return sum + (Date.parse(run.ended_at!) - Date.parse(run.started_at));
          }, 0) / finished.length;
    return {
      tasks: {
        total: tasks.length,
        by_status: byStatus,
        retried: tasks.filter((task) => task.attempts > 0).length,
      },
      runs: {
        total: runs.length,
        finished: finished.length,
        avg_duration_ms: Math.round(avgDuration),
        tokens: runs.reduce((sum, run) => sum + run.tokens, 0),
        cost_usd: runs.reduce((sum, run) => sum + run.cost_usd, 0),
      },
      nodes: this.store.listNodes().map((node) => ({
        name: node.name,
        online: this.nodeIsOnline(node),
        kind: node.kind,
      })),
      merge_queue: this.store.listMergeQueue().reduce<Record<string, number>>(
        (counts, entry) => {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return counts;
        },
        {},
      ),
      budgets: this.budgetStatus(),
    };
  }

  searchMemory(query: string, limit = 20): Record<string, unknown> {
    const q = query.trim();
    if (!q) throw new Error("Memory query is required");
    const company = this.requireCompany();
    const results = [
      ...this.store.searchPositionMemory(q, limit),
      ...this.store.searchThreads(q, limit),
    ];
    if (company.handbook.toLowerCase().includes(q.toLowerCase())) {
      results.unshift({
        kind: "company_handbook",
        excerpt: company.handbook.slice(0, 2_000),
      });
    }
    return { query: q, results: results.slice(0, limit) };
  }

  requestReview(
    taskId: string,
    reviewer: string,
  ): { review_task: Task; merge_entry: Record<string, unknown> } {
    const task = this.requireTask(taskId);
    if (task.status !== "done") {
      throw new Error(`Task ${taskId} must be done before review`);
    }
    if (task.assignee === reviewer) {
      throw new Error("Reviewer must be independent from the task author");
    }
    const reviewerPosition = this.requirePositionByName(reviewer);
    const latestReport = this.store.getLatestReportForTask(task.id);
    const change = latestReport?.report.changes?.[0] as
      | { repo?: unknown; branch?: unknown; commit?: unknown }
      | undefined;
    const repo = typeof change?.repo === "string" ? change.repo : null;
    const branch =
      typeof change?.branch === "string" ? change.branch : `task/${task.id}`;
    const commit =
      typeof change?.commit === "string" ? change.commit : null;

    const reviewTask: Task = {
      id: newId("t"),
      company_id: MAIN_COMPANY_ID,
      thread_id: task.thread_id,
      parent_task_id: task.id,
      task_key: `review-${task.id.slice(-6)}`,
      title: `Review: ${task.title}`,
      objective: `Independently review task ${task.id}. Check acceptance, diff, tests and risks. Do not rewrite the feature unless a real defect is found.`,
      assignee: reviewer,
      status: "queued",
      priority: task.priority,
      acceptance: ["review report contains verdict", "evidence or residual risks"],
      constraints: { review_of: task.id },
      inputs: [],
      budget: {},
      deadline: null,
      attempts: 0,
      max_retries: 0,
      lease_owner: null,
      lease_expires_at: null,
      lease_token: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.store.insertTask(reviewTask);
    this.store.addTaskEdge(reviewTask.id, task.id);
    const entry = {
      id: newId("mq"),
      company_id: MAIN_COMPANY_ID,
      task_id: task.id,
      review_task_id: reviewTask.id,
      repo,
      branch,
      commit,
      merge_commit: null,
      status: "pending_review" as const,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.store.insertMergeQueue(entry);
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "review.requested",
      payload: {
        review_task_id: reviewTask.id,
        reviewer: reviewerPosition.name,
        merge_entry_id: entry.id,
      },
      created_at: nowIso(),
    });
    const assignedReview = this.assignTask(reviewTask.id);
    return { review_task: assignedReview, merge_entry: entry };
  }

  mergeQueue(
    status?: "pending_review" | "ready" | "merged" | "rejected",
  ): MergeQueueEntry[] {
    return this.store.listMergeQueue(status);
  }

  approveMerge(entryId: string): Record<string, unknown> {
    const entry = this.store.getMergeQueueEntry(entryId);
    if (!entry) throw new Error(`Merge entry not found: ${entryId}`);
    if (entry.status !== "ready") {
      throw new Error(`Merge entry is ${entry.status}, expected ready`);
    }
    const entryTask = this.store.getTask(entry.task_id);
    if (!entryTask) throw new Error(`Task not found: ${entry.task_id}`);
    const integration = this.store
      .listTasks(MAIN_COMPANY_ID, entryTask.thread_id)
      .find((task) => task.constraints.integration === true);
    if (integration && integration.id !== entryTask.id) {
      throw new Error(
        `Thread has an integration task (${integration.id}); only the integration result can be merged`,
      );
    }
    if (integration && integration.status !== "done") {
      throw new Error(`Integration task is ${integration.status}, not done`);
    }
    const mergeCommit = this.mergeEntry(entry);
    this.store.markMergeQueueMerged(entry.id, mergeCommit ?? entry.commit ?? "");
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: entry.task_id,
      type: "merge.approved",
      payload: {
        entry_id: entry.id,
        repo: entry.repo,
        branch: entry.branch,
        commit: entry.commit,
        merge_commit: mergeCommit,
      },
      created_at: nowIso(),
    });
    return this.store.getMergeQueueEntry(entry.id) as unknown as Record<
      string,
      unknown
    >;
  }

  private mergeEntry(entry: MergeQueueEntry): string | null {
    if (!entry.repo || !entry.commit) return null;
    if (!existsSync(entry.repo)) {
      // Remote/fake tasks may only have a symbolic repo. The queue still
      // records the audit state, but there is nothing to merge locally.
      return null;
    }
    const status = spawnSync("git", ["-C", entry.repo, "status", "--porcelain"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (status.status !== 0) {
      throw new Error(`Not a git repo: ${entry.repo}`);
    }
    if (status.stdout.trim()) {
      throw new Error(`Refusing to merge into a dirty repo: ${entry.repo}`);
    }
    const merge = spawnSync(
      "git",
      ["-C", entry.repo, "merge", "--ff-only", entry.commit],
      { encoding: "utf8", windowsHide: true },
    );
    if (merge.status !== 0) {
      throw new Error(
        `git merge --ff-only failed: ${(merge.stderr || merge.stdout).trim()}`,
      );
    }
    const head = spawnSync("git", ["-C", entry.repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return head.status === 0 ? head.stdout.trim() : null;
  }

  rejectMerge(entryId: string, reason: string): Record<string, unknown> {
    const entry = this.store.getMergeQueueEntry(entryId);
    if (!entry) throw new Error(`Merge entry not found: ${entryId}`);
    if (entry.status === "merged") throw new Error("Already merged");
    this.store.updateMergeQueueStatus(entry.id, "rejected");
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: entry.task_id,
      type: "merge.rejected",
      payload: { entry_id: entry.id, reason },
      created_at: nowIso(),
    });
    return this.store.getMergeQueueEntry(entry.id) as unknown as Record<string, unknown>;
  }

  private async handleToolApproval(
    task: Task,
    position: Position,
    request: ApprovalRequest,
  ): Promise<ApprovalDecision> {
    if (this.toolIsAllowed(task, request)) {
      return { allow: true };
    }
    const decision: Decision = {
      id: newId("d"),
      company_id: MAIN_COMPANY_ID,
      thread_id: task.thread_id,
      task_id: task.id,
      question: `${position.name} 请求执行工具 ${request.tool_name}：${JSON.stringify(request.input).slice(0, 1200)}`,
      options: ["允许", "拒绝"],
      status: "open",
      chosen: null,
      rationale: null,
      created_at: nowIso(),
      resolved_at: null,
    };
    this.store.insertDecision(decision);
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "approval.requested",
      payload: {
        decision_id: decision.id,
        tool_name: request.tool_name,
        input: request.input,
        reason: request.reason,
      },
      created_at: nowIso(),
    });

    const deadline = Date.now() + this.approvalTimeoutMs;
    while (Date.now() < deadline) {
      const current = this.store.getDecision(decision.id);
      if (current?.status === "resolved") {
        const allow = /allow|approve|允许|批准|yes/i.test(
          current.chosen ?? "",
        );
        return {
          allow,
          message: allow
            ? undefined
            : current.rationale ?? "Denied by human",
        };
      }
      await sleep(200);
    }
    this.store.resolveDecision(
      decision.id,
      "拒绝",
      "approval timed out",
    );
    return { allow: false, message: "Tool approval timed out" };
  }

  private toolIsAllowed(task: Task, request: ApprovalRequest): boolean {
    if (task.constraints.auto_approve_tools === true) return true;
    const denied = Array.isArray(task.constraints.denied_tools)
      ? (task.constraints.denied_tools as unknown[]).map(String)
      : [];
    const allowed = Array.isArray(task.constraints.allowed_tools)
      ? (task.constraints.allowed_tools as unknown[]).map(String)
      : [];
    const haystack = `${request.tool_name} ${JSON.stringify(request.input)}`;
    const matches = (pattern: string): boolean => {
      const escaped = pattern
        .replaceAll(/[.+^${}()|[\]\\]/g, "\\$&")
        .replaceAll("*", ".*");
      return new RegExp(`^${escaped}$`, "i").test(haystack);
    };
    if (denied.some(matches)) return false;
    return allowed.some(matches);
  }

  private assertBudget(task: Task, position: Position): void {
    const company = this.requireCompany();
    const companyLimit = this.numberBudget(company.budget.usd);
    if (companyLimit !== null && this.store.companySpend() >= companyLimit) {
      throw new BudgetExceededError(
        `Company budget exceeded: ${this.store.companySpend()} / ${companyLimit} USD`,
      );
    }
    const companyMinutesLimit = this.numberBudget(company.budget.minutes);
    if (
      companyMinutesLimit !== null &&
      this.store.companyMinutes() >= companyMinutesLimit
    ) {
      throw new BudgetExceededError(
        `Company minute budget exceeded: ${this.store.companyMinutes().toFixed(1)} / ${companyMinutesLimit} min`,
      );
    }
    const positionLimit = this.numberBudget(position.budget.usd);
    if (positionLimit !== null && this.store.positionSpend(position.id) >= positionLimit) {
      throw new BudgetExceededError(
        `Position ${position.name} budget exceeded: ${this.store.positionSpend(position.id)} / ${positionLimit} USD`,
      );
    }
    const positionMinutesLimit = this.numberBudget(position.budget.minutes);
    if (
      positionMinutesLimit !== null &&
      this.store.positionMinutes(position.id) >= positionMinutesLimit
    ) {
      throw new BudgetExceededError(
        `Position ${position.name} minute budget exceeded: ${this.store.positionMinutes(position.id).toFixed(1)} / ${positionMinutesLimit} min`,
      );
    }
    const taskLimit = this.numberBudget(task.budget.usd);
    if (taskLimit !== null && this.store.taskSpend(task.id) >= taskLimit) {
      throw new BudgetExceededError(
        `Task ${task.id} budget exceeded: ${this.store.taskSpend(task.id)} / ${taskLimit} USD`,
      );
    }
    const taskMinutesLimit = this.numberBudget(task.budget.minutes);
    if (
      taskMinutesLimit !== null &&
      this.store.taskMinutes(task.id) >= taskMinutesLimit
    ) {
      throw new BudgetExceededError(
        `Task ${task.id} minute budget exceeded: ${this.store.taskMinutes(task.id).toFixed(1)} / ${taskMinutesLimit} min`,
      );
    }
  }

  private enforceTaskBudget(task: Task, runId: string): void {
    const usdLimit = this.numberBudget(task.budget.usd);
    const minutesLimit = this.numberBudget(task.budget.minutes);
    const spent = this.store.taskSpend(task.id);
    const minutes = this.store.taskMinutes(task.id);
    const usdExceeded = usdLimit !== null && spent > usdLimit;
    const minutesExceeded = minutesLimit !== null && minutes > minutesLimit;
    if (usdExceeded || minutesExceeded) {
      this.store.updateTaskStatus(task.id, "blocked");
      this.recordRunEvent(runId, task.id, "budget.exceeded", {
        budget_usd: usdLimit,
        spent_usd: spent,
        budget_minutes: minutesLimit,
        spent_minutes: minutes,
      });
    }
  }

  private numberBudget(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private markReviewReady(task: Task, report: Report): void {
    if (
      report.status !== "done" ||
      typeof task.constraints.review_of !== "string"
    ) {
      return;
    }
    const entry = this.store.findMergeByReviewTask(task.id);
    if (entry && entry.status === "pending_review") {
      this.store.updateMergeQueueStatus(entry.id, "ready");
      this.store.insertEvent({
        id: newId("e"),
        run_id: null,
        task_id: task.id,
        type: "merge.ready",
        payload: { entry_id: entry.id, review_task_id: task.id },
        created_at: nowIso(),
      });
    }
  }

  private maybeAutoRetry(task: Task, report: Report, position: Position): boolean {
    if (report.status !== "failed" || task.attempts >= task.max_retries) {
      return false;
    }
    this.store.incrementTaskAttempt(task.id);
    this.store.updatePositionStatus(position.id, "idle");
    this.store.insertEvent({
      id: newId("e"),
      run_id: null,
      task_id: task.id,
      type: "task.retry",
      payload: {
        attempt: task.attempts + 1,
        max_retries: task.max_retries,
      },
      created_at: nowIso(),
    });
    return true;
  }

  setNodeDrain(identifier: string, drain: boolean): Node {
    const node = this.nodeByIdentifier(identifier);
    this.store.setNodeDrain(node.id, drain);
    return this.requireNode(node.id);
  }

  revokeNode(identifier: string): Node {
    const node = this.nodeByIdentifier(identifier);
    this.store.setNodeDrain(node.id, true);
    this.store.revokeNode(node.id);
    return this.requireNode(node.id);
  }

  private authenticateNode(token: string): Node {
    if (!token) throw new Error("Missing node token");
    const node = this.store.getNodeByTokenHash(this.hashToken(token));
    if (!node) throw new Error("Invalid node token");
    if (node.revoked_at) throw new Error(`Node ${node.name} is revoked`);
    return node;
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private nodeByIdentifier(identifier: string): Node {
    const byId = this.store.getNode(identifier);
    if (byId) return byId;
    const byName = this.store.getNodeByName(identifier);
    if (byName) return byName;
    throw new Error(`Node not found: ${identifier}`);
  }

  private requireNode(id: string): Node {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    return node;
  }

  private nodeIsOnline(node: Node): boolean {
    if (node.revoked_at) return false;
    if (node.kind === "local") return true;
    return Date.now() - Date.parse(node.last_seen_at) < 30_000;
  }

  // ---------- context / execution helpers ----------

  private adapterFor(position: Position): HarnessAdapter {
    const adapter = this.adapters.get(position.harness_kind);
    if (!adapter) {
      throw new Error(
        `No harness adapter registered for "${position.harness_kind}" (position ${position.name})`,
      );
    }
    return adapter;
  }

  private prepareWorkspace(
    position: Position,
    task: Task,
  ): PreparedWorkspace {
    if (
      position.harness_kind === "fake" ||
      position.policy.worktree === false
    ) {
      mkdirSync(position.workspace, { recursive: true });
      return {
        cwd: position.workspace,
        repo: position.workspace,
        branch: "",
        base_ref: "",
        is_git: false,
      };
    }
    const baseRepo =
      typeof position.policy.repo_path === "string"
        ? position.policy.repo_path
        : position.workspace;
    const baseRef =
      typeof task.constraints.base_ref === "string"
        ? task.constraints.base_ref
        : undefined;
    const branchName =
      task.constraints.integration === true
        ? `integration/${task.thread_id}`
        : undefined;
    return this.workspaceManager.prepare(
      baseRepo,
      task.id,
      baseRef,
      branchName,
    );
  }

  private timeoutForTask(task: Task): number {
    const minutes = task.budget.minutes;
    if (minutes && minutes > 0) {
      return Math.min(minutes, 60) * 60_000;
    }
    return 10 * 60_000;
  }

  private usableSession(
    position: Position,
    adapter: HarnessAdapter,
    workspace: PreparedWorkspace,
  ): SessionRef | null {
    const session = this.store.getSessionRef(position.id);
    if (!session || session.status !== "active") return null;
    if (session.harness_kind !== adapter.kind) return null;
    if (session.cwd !== workspace.cwd) return null;
    if (position.model && session.model && session.model !== position.model) {
      return null;
    }
    if (session.expires_at && Date.parse(session.expires_at) <= Date.now()) {
      return null;
    }
    return session;
  }

  private recordRunEvent(
    runId: string,
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.store.insertEvent({
      id: newId("e"),
      run_id: runId,
      task_id: taskId,
      type,
      payload,
      created_at: nowIso(),
    });
    try {
      const logDir = join(process.cwd(), ".aic", "logs");
      mkdirSync(logDir, { recursive: true });
      appendFileSync(
        join(logDir, `${runId}.jsonl`),
        `${JSON.stringify({ ts: nowIso(), run_id: runId, type, payload })}\n`,
        "utf8",
      );
    } catch {
      // Logging must never break a run.
    }
  }

  private recordHarnessEvent(
    runId: string,
    taskId: string,
    event: HarnessEvent,
  ): void {
    this.recordRunEvent(runId, taskId, `harness.${event.type}`, {
      ...event,
    });
  }

  private runTestCommand(
    task: Task,
    cwd: string,
  ): { command: string; passed: boolean; exit_code: number | null; output: string } | null {
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

  private enrichReport(
    result: HarnessRunResult,
    task: Task,
    workspace: PreparedWorkspace,
    finalized: WorkspaceResult,
    test: ReturnType<CompanyService["runTestCommand"]>,
    runId: string,
  ): Report {
    const evidence = [...result.report.evidence];
    const risks = [...result.report.risks];
    let testArtifact: string | null = null;
    if (test) {
      try {
        const artifactDir = join(process.cwd(), ".aic", "artifacts");
        mkdirSync(artifactDir, { recursive: true });
        testArtifact = join(artifactDir, `${runId}.test.txt`);
        writeFileSync(
          testArtifact,
          `$ ${test.command}\nexit: ${test.exit_code}\n\n${test.output}\n`,
          "utf8",
        );
      } catch {
        testArtifact = null;
      }
      evidence.push({
        kind: "test",
        command: test.command,
        result: test.passed ? "pass" : "fail",
        exit_code: test.exit_code,
        output_tail: test.output.slice(-2000),
        ...(testArtifact ? { artifact: testArtifact } : {}),
      });
      if (!test.passed) {
        risks.push(`测试命令失败：${test.command}`);
      }
    }
    if (finalized.diff_path) {
      evidence.push({ kind: "diff", artifact: finalized.diff_path });
    }

    const failedByTest = Boolean(test && !test.passed);
    const status: Report["status"] = failedByTest
      ? "failed"
      : result.report.status;
    let summary = result.report.summary;
    if (failedByTest) {
      summary += `\n\n测试失败（${test?.command}）：\n${test?.output.slice(-1500)}`;
    }
    const branch = workspace.branch || result.report.handoff.branch;
    const next =
      status === "failed"
        ? ["由 CEO 决定重试或转派"]
        : result.report.next.length
          ? result.report.next
          : ["由 CEO 验收"];

    return {
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
        ],
        next_steps:
          result.report.handoff.next_steps.length > 0
            ? result.report.handoff.next_steps
            : next,
      },
      next,
    };
  }

  private contextPack(
    task: Task,
    position: Position,
    workspace: PreparedWorkspace,
    instruction?: string,
  ): { pack: ContextPack; contextPackId: string } {
    const thread = this.store.getThread(task.thread_id);
    if (!thread) throw new Error(`Thread not found: ${task.thread_id}`);
    const memory = this.store.listMemory(position.id);
    const relatedReports = this.store
      .listReportsForThread(thread.id)
      .filter((report) => report.task_id !== task.id)
      .slice(-3)
      .map((report) => ({
        task_id: report.task_id,
        status: report.status,
        summary: report.summary,
      }));
    const session = this.store.getSessionRef(position.id);
    const latestReport = this.store.getLatestReportForTask(task.id);
    const workspaceInfo = {
      path: workspace.cwd,
      branch: workspace.branch || `task/${task.id}`,
      is_git: workspace.is_git,
      base_ref: workspace.base_ref,
      latest_report: latestReport
        ? { status: latestReport.status, summary: latestReport.summary }
        : null,
      session_status: session?.status ?? "cold",
    };
    const base = {
      schema: "context_pack/v1" as const,
      position,
      thread,
      task,
      memory,
      related_reports: relatedReports,
      session_ref: session,
      workspace: workspaceInfo,
      instruction: instruction?.trim() || task.objective,
      changed_since_last_run: latestReport
        ? [`上一次报告：${latestReport.summary}`]
        : [],
      do_not_redo: ["不要重复已完成的工作；先读取 HANDOFF 和上一次报告"],
    };
    const context_hash = sha256(base);
    const pack: ContextPack = {
      ...base,
      context_hash,
    };
    const contextPackId = newId("cp");
    this.store.insertContextPack(contextPackId, task.id, null, pack);
    return { pack, contextPackId };
  }

  private reportToTaskStatus(status: ReportStatus): TaskStatus {
    switch (status) {
      case "done":
        return "done";
      case "blocked":
        return "blocked";
      case "needs_decision":
        return "waiting_approval";
      case "failed":
        return "failed";
    }
  }

  private requireCompany(): Company {
    const company = this.store.getCompany();
    if (!company) throw new Error("Company not initialized");
    return company;
  }

  private requireTask(id: string): Task {
    const task = this.store.getTask(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    return task;
  }

  private requirePosition(id: string): Position {
    const position = this.store.getPosition(id);
    if (!position) throw new Error(`Position not found: ${id}`);
    return position;
  }

  private requirePositionByName(name: string): Position {
    const position = this.store.getPositionByName(name);
    if (!position) throw new Error(`Position not found: ${name}`);
    return position;
  }

  private positionForTask(task: Task): Position {
    if (!task.assignee) throw new Error(`Task ${task.id} has no assignee`);
    const position = this.store.getPositionByName(task.assignee);
    if (!position) throw new Error(`Position not found: ${task.assignee}`);
    if (position.status === "fired") {
      throw new Error(`Position ${position.name} has been fired`);
    }
    if (position.status === "paused") {
      throw new Error(`Position ${position.name} is paused`);
    }
    return position;
  }
}
