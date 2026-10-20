import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
  type Position,
  type Report,
  type ReportStatus,
  type Task,
  type TaskStatus,
  type Thread,
} from "../domain/schema";
import { assertTransition, isTerminal } from "../domain/state";
import { FakeHarness } from "../adapters/fake";
import { Store, newId, nowIso } from "../store/store";

const DEFAULT_DB_PATH = join(process.cwd(), ".aic", "company.db");

const HANDBOOK = `# AI Company 员工手册（M0）

## 公司原则
- 人类只与 CEO 沟通，员工没有人类入口。
- 每张任务必须有目标、验收标准和明确的负责人。
- 员工只返回结构化报告，不返回无边界的聊天记录。
- 原生 harness session 只是缓存；任务线程、职位记忆和产物才是长期记忆。

## M0 范围
- 使用 Fake Harness 验证 CEO 管理链路。
- 任务在本地 SQLite 中持久化。
- 不接真实 Claude Code / opencode / pi，不接远程节点。
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

  constructor(options: CompanyServiceOptions = {}) {
    this.store = new Store(options.dbPath ?? DEFAULT_DB_PATH);
    this.fake = new FakeHarness(options.fakeDelayMs ?? 5);
    if (options.seed !== false) {
      this.seed();
    }
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

    if (!this.store.getNode()) {
      this.store.insertNode({
        id: LOCAL_NODE_ID,
        company_id: MAIN_COMPANY_ID,
        name: "local",
        os: process.platform,
        status: "online",
        capabilities: {
          harnesses: ["fake"],
          max_concurrency: 3,
          remote: false,
        },
        last_seen_at: nowIso(),
      });
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
    if (task.status === "queued") {
      this.store.updateTaskStatus(task.id, "assigned");
      task = this.requireTask(task.id);
    }
    assertTransition(task.status, "running");
    const { pack, contextPackId } = this.contextPack(task, position, instruction);
    const runId = newId("r");
    this.store.createRun({
      id: runId,
      task_id: task.id,
      position_id: position.id,
      status: "running",
      session_ref: null,
      context_pack_id: contextPackId,
      started_at: nowIso(),
      ended_at: null,
      cost: {},
    });
    this.store.updateTaskStatus(task.id, "running");
    this.store.updatePositionStatus(position.id, "busy");
    this.store.insertEvent({
      id: newId("e"),
      run_id: runId,
      task_id: task.id,
      type: "run.started",
      payload: {
        position: position.name,
        context_pack_id: contextPackId,
        resumed: Boolean(pack.session_ref),
      },
      created_at: nowIso(),
    });

    try {
      const report = await this.fake.execute({
        task: this.requireTask(task.id),
        position,
        context: pack,
        instruction,
      });
      const validated = ReportSchema.parse(report);
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
        cost: { tokens: 0, usd: 0 },
      });

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
      this.store.upsertSessionRef({
        id: existingSession?.id ?? newId("s"),
        position_id: position.id,
        harness_kind: position.harness_kind,
        session_id: existingSession?.session_id ?? `fake:${position.name}`,
        cwd: position.workspace,
        model: position.model,
        harness_version: "fake-m0",
        context_hash: pack.context_hash,
        last_used_at: nowIso(),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        status: "active",
      });

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
              kind: "evidence",
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

      this.store.insertEvent({
        id: newId("e"),
        run_id: runId,
        task_id: task.id,
        type: "run.finished",
        payload: {
          status: validated.status,
          summary: validated.summary,
        },
        created_at: nowIso(),
      });

      return {
        task: this.requireTask(task.id),
        position: this.requirePosition(position.id),
        report: validated,
        run_id: runId,
      };
    } catch (error) {
      const current = this.store.getTask(task.id);
      if (current?.status === "running") {
        this.store.updateTaskStatus(task.id, "failed");
      }
      this.store.updatePositionStatus(position.id, "idle");
      this.store.updateRun(runId, {
        status: "failed",
        ended_at: nowIso(),
        cost: {},
      });
      this.store.insertEvent({
        id: newId("e"),
        run_id: runId,
        task_id: task.id,
        type: "run.error",
        payload: {
          message: error instanceof Error ? error.message : String(error),
        },
        created_at: nowIso(),
      });
      throw error;
    }
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
      if (task && task.status === "waiting_approval") {
        this.store.updateTaskStatus(task.id, "assigned");
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
    const workspace =
      parsed.workspace ??
      join(process.cwd(), ".aic", "workspaces", parsed.name);
    mkdirSync(workspace, { recursive: true });
    const position: Position = {
      id: newId("p"),
      company_id: MAIN_COMPANY_ID,
      node_id: LOCAL_NODE_ID,
      name: parsed.name,
      role: parsed.role,
      harness_kind: parsed.harness_kind,
      model: parsed.model ?? null,
      status: "idle",
      workspace,
      policy: DEFAULT_POLICY,
      budget: { usd: 5, minutes: 60 },
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
    return this.store.listNodes().map((node) => ({
      ...node,
      positions: this.store
        .listPositions()
        .filter((position) => position.node_id === node.id)
        .map((position) => position.name),
    }));
  }

  // ---------- context / helpers ----------

  private contextPack(
    task: Task,
    position: Position,
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
    const workspace = {
      branch: `task/${task.id}`,
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
      workspace,
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
