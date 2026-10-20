import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ArtifactRecord,
  Budget,
  Company,
  Decision,
  EventRecord,
  MemoryEntry,
  Node,
  Position,
  PositionStatus,
  Report,
  ReportRecord,
  ReportStatus,
  Run,
  SessionRef,
  Task,
  TaskStatus,
  Thread,
} from "../domain/schema";
import { MAIN_COMPANY_ID, LOCAL_NODE_ID } from "../domain/schema";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  handbook TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  harness_kind TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  workspace TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  parent_task_id TEXT,
  task_key TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  assignee TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  acceptance_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  budget_json TEXT NOT NULL,
  deadline TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_edges (
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  position_id TEXT NOT NULL,
  status TEXT NOT NULL,
  session_ref TEXT,
  context_pack_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  cost_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  thread_id TEXT,
  task_id TEXT,
  question TEXT NOT NULL,
  options_json TEXT NOT NULL,
  status TEXT NOT NULL,
  chosen TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS session_refs (
  id TEXT PRIMARY KEY,
  position_id TEXT NOT NULL UNIQUE,
  harness_kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT,
  harness_version TEXT,
  context_hash TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS position_memory (
  position_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (position_id, key)
);

CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  pack_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  sha256 TEXT,
  meta_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_reports_task ON reports(task_id);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status);
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function encodeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function decodeJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

export class Store {
  readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  // ---------- company / node ----------

  getCompany(id = MAIN_COMPANY_ID): Company | null {
    const row = this.db
      .prepare("SELECT * FROM companies WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      name: asString(row.name),
      handbook: asString(row.handbook),
      policy: decodeJson(row.policy_json as string, {}),
      budget: decodeJson(row.budget_json as string, {}),
      created_at: asString(row.created_at),
    };
  }

  insertCompany(company: Company): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO companies
         (id, name, handbook, policy_json, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        company.id,
        company.name,
        company.handbook,
        encodeJson(company.policy),
        encodeJson(company.budget),
        company.created_at,
      );
  }

  getNode(id = LOCAL_NODE_ID): Node | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      name: asString(row.name),
      os: asString(row.os),
      status: asString(row.status),
      capabilities: decodeJson(row.capabilities_json as string, {}),
      last_seen_at: asString(row.last_seen_at),
    };
  }

  insertNode(node: Node): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nodes
         (id, company_id, name, os, status, capabilities_json, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.company_id,
        node.name,
        node.os,
        node.status,
        encodeJson(node.capabilities),
        node.last_seen_at,
      );
  }

  listNodes(companyId = MAIN_COMPANY_ID): Node[] {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE company_id = ? ORDER BY name")
      .all(companyId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      company_id: asString(row.company_id),
      name: asString(row.name),
      os: asString(row.os),
      status: asString(row.status),
      capabilities: decodeJson(row.capabilities_json as string, {}),
      last_seen_at: asString(row.last_seen_at),
    }));
  }

  // ---------- positions ----------

  getPosition(id: string): Position | null {
    const row = this.db
      .prepare("SELECT * FROM positions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.positionFromRow(row) : null;
  }

  getPositionByName(name: string): Position | null {
    const row = this.db
      .prepare("SELECT * FROM positions WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    return row ? this.positionFromRow(row) : null;
  }

  listPositions(companyId = MAIN_COMPANY_ID): Position[] {
    const rows = this.db
      .prepare("SELECT * FROM positions WHERE company_id = ? ORDER BY name")
      .all(companyId) as Record<string, unknown>[];
    return rows.map((row) => this.positionFromRow(row));
  }

  insertPosition(position: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions
         (id, company_id, node_id, name, role, harness_kind, model, status, workspace, policy_json, budget_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        position.id,
        position.company_id,
        position.node_id,
        position.name,
        position.role,
        position.harness_kind,
        position.model,
        position.status,
        position.workspace,
        encodeJson(position.policy),
        encodeJson(position.budget),
        position.created_at,
      );
  }

  updatePositionStatus(id: string, status: PositionStatus): void {
    this.db
      .prepare("UPDATE positions SET status = ? WHERE id = ?")
      .run(status, id);
  }

  // ---------- threads ----------

  createThread(thread: Thread): Thread {
    this.db
      .prepare(
        `INSERT INTO threads
         (id, company_id, title, goal, status, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.company_id,
        thread.title,
        thread.goal,
        thread.status,
        thread.summary,
        thread.created_at,
        thread.updated_at,
      );
    return thread;
  }

  getThread(id: string): Thread | null {
    const row = this.db
      .prepare("SELECT * FROM threads WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.threadFromRow(row) : null;
  }

  listThreads(companyId = MAIN_COMPANY_ID): Thread[] {
    const rows = this.db
      .prepare("SELECT * FROM threads WHERE company_id = ? ORDER BY updated_at DESC")
      .all(companyId) as Record<string, unknown>[];
    return rows.map((row) => this.threadFromRow(row));
  }

  updateThreadSummary(id: string, summary: string): void {
    this.db
      .prepare("UPDATE threads SET summary = ?, updated_at = ? WHERE id = ?")
      .run(summary, nowIso(), id);
  }

  // ---------- tasks ----------

  insertTask(task: Task): Task {
    this.db
      .prepare(
        `INSERT INTO tasks
         (id, company_id, thread_id, parent_task_id, task_key, title, objective,
          assignee, status, priority, acceptance_json, constraints_json, inputs_json,
          budget_json, deadline, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.company_id,
        task.thread_id,
        task.parent_task_id,
        task.task_key,
        task.title,
        task.objective,
        task.assignee,
        task.status,
        task.priority,
        encodeJson(task.acceptance),
        encodeJson(task.constraints),
        encodeJson(task.inputs),
        encodeJson(task.budget),
        task.deadline,
        task.created_at,
        task.updated_at,
      );
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  listTasks(companyId = MAIN_COMPANY_ID, threadId?: string): Task[] {
    const rows = threadId
      ? (this.db
          .prepare(
            "SELECT * FROM tasks WHERE company_id = ? AND thread_id = ? ORDER BY priority DESC, created_at ASC",
          )
          .all(companyId, threadId) as Record<string, unknown>[])
      : (this.db
          .prepare(
            "SELECT * FROM tasks WHERE company_id = ? ORDER BY priority DESC, created_at ASC",
          )
          .all(companyId) as Record<string, unknown>[]);
    return rows.map((row) => this.taskFromRow(row));
  }

  listTasksByStatus(status: TaskStatus, companyId = MAIN_COMPANY_ID): Task[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE company_id = ? AND status = ? ORDER BY priority DESC, created_at ASC",
      )
      .all(companyId, status) as Record<string, unknown>[];
    return rows.map((row) => this.taskFromRow(row));
  }

  updateTaskStatus(id: string, status: TaskStatus): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  updateTaskAssignee(id: string, assignee: string): void {
    this.db
      .prepare("UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?")
      .run(assignee, nowIso(), id);
  }

  updateTaskConstraints(id: string, constraints: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE tasks SET constraints_json = ?, updated_at = ? WHERE id = ?")
      .run(encodeJson(constraints), nowIso(), id);
  }

  addTaskEdge(taskId: string, dependsOn: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO task_edges (task_id, depends_on) VALUES (?, ?)")
      .run(taskId, dependsOn);
  }

  listDependencies(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT depends_on FROM task_edges WHERE task_id = ?")
      .all(taskId) as { depends_on: string }[];
    return rows.map((row) => row.depends_on);
  }

  dependenciesDone(taskId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS missing
         FROM task_edges e
         JOIN tasks t ON t.id = e.depends_on
         WHERE e.task_id = ? AND t.status != 'done'`,
      )
      .get(taskId) as { missing: number } | undefined;
    return (row?.missing ?? 0) === 0;
  }

  // ---------- runs / reports ----------

  createRun(run: Run): Run {
    this.db
      .prepare(
        `INSERT INTO runs
         (id, task_id, position_id, status, session_ref, context_pack_id, started_at, ended_at, cost_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.task_id,
        run.position_id,
        run.status,
        run.session_ref,
        run.context_pack_id,
        run.started_at,
        run.ended_at,
        encodeJson(run.cost),
      );
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<Pick<Run, "status" | "ended_at" | "cost" | "session_ref" | "context_pack_id">>,
  ): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    this.db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, cost_json = ?, session_ref = ?, context_pack_id = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.ended_at ?? current.ended_at,
        encodeJson(patch.cost ?? current.cost),
        patch.session_ref ?? current.session_ref,
        patch.context_pack_id ?? current.context_pack_id,
        id,
      );
  }

  getRun(id: string): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.runFromRow(row) : null;
  }

  getLatestRunForTask(taskId: string): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? this.runFromRow(row) : null;
  }

  listRunsForTask(taskId: string): Run[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.runFromRow(row));
  }

  insertReport(report: ReportRecord): void {
    this.db
      .prepare(
        `INSERT INTO reports (id, task_id, run_id, status, summary, report_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.task_id,
        report.run_id,
        report.status,
        report.summary,
        encodeJson(report.report),
        report.created_at,
      );
  }

  listReportsForTask(taskId: string): ReportRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM reports WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.reportFromRow(row));
  }

  getLatestReportForTask(taskId: string): ReportRecord | null {
    const row = this.db
      .prepare("SELECT * FROM reports WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? this.reportFromRow(row) : null;
  }

  listReportsForThread(threadId: string): ReportRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM reports r
         JOIN tasks t ON t.id = r.task_id
         WHERE t.thread_id = ?
         ORDER BY r.created_at ASC`,
      )
      .all(threadId) as Record<string, unknown>[];
    return rows.map((row) => this.reportFromRow(row));
  }

  // ---------- events ----------

  insertEvent(event: Omit<EventRecord, "seq"> & { seq?: number }): EventRecord {
    const next =
      event.seq ??
      ((this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events")
        .get() as { n: number }).n || 1);
    const record: EventRecord = {
      ...event,
      seq: next,
    };
    this.db
      .prepare(
        `INSERT INTO events (id, run_id, task_id, seq, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.run_id,
        record.task_id,
        record.seq,
        record.type,
        encodeJson(record.payload),
        record.created_at,
      );
    return record;
  }

  listEventsForTask(taskId: string): EventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE task_id = ? ORDER BY seq ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => this.eventFromRow(row));
  }

  // ---------- decisions ----------

  insertDecision(decision: Decision): Decision {
    this.db
      .prepare(
        `INSERT INTO decisions
         (id, company_id, thread_id, task_id, question, options_json, status, chosen, rationale, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.company_id,
        decision.thread_id,
        decision.task_id,
        decision.question,
        encodeJson(decision.options),
        decision.status,
        decision.chosen,
        decision.rationale,
        decision.created_at,
        decision.resolved_at,
      );
    return decision;
  }

  getDecision(id: string): Decision | null {
    const row = this.db
      .prepare("SELECT * FROM decisions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.decisionFromRow(row) : null;
  }

  listOpenDecisions(companyId = MAIN_COMPANY_ID): Decision[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM decisions WHERE company_id = ? AND status = 'open' ORDER BY created_at ASC",
      )
      .all(companyId) as Record<string, unknown>[];
    return rows.map((row) => this.decisionFromRow(row));
  }

  resolveDecision(id: string, chosen: string, rationale: string | null): void {
    this.db
      .prepare(
        `UPDATE decisions SET status = 'resolved', chosen = ?, rationale = ?, resolved_at = ? WHERE id = ?`,
      )
      .run(chosen, rationale, nowIso(), id);
  }

  // ---------- sessions / memory / context / artifacts ----------

  upsertSessionRef(ref: SessionRef): void {
    this.db
      .prepare(
        `INSERT INTO session_refs
         (id, position_id, harness_kind, session_id, cwd, model, harness_version,
          context_hash, last_used_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(position_id) DO UPDATE SET
           harness_kind = excluded.harness_kind,
           session_id = excluded.session_id,
           cwd = excluded.cwd,
           model = excluded.model,
           harness_version = excluded.harness_version,
           context_hash = excluded.context_hash,
           last_used_at = excluded.last_used_at,
           expires_at = excluded.expires_at,
           status = excluded.status`,
      )
      .run(
        ref.id,
        ref.position_id,
        ref.harness_kind,
        ref.session_id,
        ref.cwd,
        ref.model,
        ref.harness_version,
        ref.context_hash,
        ref.last_used_at,
        ref.expires_at,
        ref.status,
      );
  }

  getSessionRef(positionId: string): SessionRef | null {
    const row = this.db
      .prepare("SELECT * FROM session_refs WHERE position_id = ?")
      .get(positionId) as Record<string, unknown> | undefined;
    return row ? this.sessionRefFromRow(row) : null;
  }

  upsertMemory(positionId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO position_memory (position_id, key, value_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(position_id, key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(positionId, key, encodeJson(value), nowIso());
  }

  listMemory(positionId: string): MemoryEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM position_memory WHERE position_id = ? ORDER BY key")
      .all(positionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      position_id: asString(row.position_id),
      key: asString(row.key),
      value: decodeJson(row.value_json as string, null),
      updated_at: asString(row.updated_at),
    }));
  }

  insertContextPack(id: string, taskId: string, runId: string | null, pack: unknown): void {
    this.db
      .prepare(
        `INSERT INTO context_packs (id, task_id, run_id, pack_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, taskId, runId, encodeJson(pack), nowIso());
  }

  insertArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, run_id, kind, uri, sha256, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.task_id,
        artifact.run_id,
        artifact.kind,
        artifact.uri,
        artifact.sha256,
        encodeJson(artifact.meta),
        artifact.created_at,
      );
  }

  listArtifactsForTask(taskId: string): ArtifactRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: asString(row.id),
      task_id: asString(row.task_id),
      run_id: (row.run_id as string | null) ?? null,
      kind: asString(row.kind),
      uri: asString(row.uri),
      sha256: (row.sha256 as string | null) ?? null,
      meta: decodeJson(row.meta_json as string, {}),
      created_at: asString(row.created_at),
    }));
  }

  // ---------- row mappers ----------

  private positionFromRow(row: Record<string, unknown>): Position {
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      node_id: asString(row.node_id),
      name: asString(row.name),
      role: asString(row.role),
      harness_kind: asString(row.harness_kind),
      model: (row.model as string | null) ?? null,
      status: asString(row.status) as PositionStatus,
      workspace: asString(row.workspace),
      policy: decodeJson(row.policy_json as string, {}),
      budget: decodeJson(row.budget_json as string, {}),
      created_at: asString(row.created_at),
    };
  }

  private threadFromRow(row: Record<string, unknown>): Thread {
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      title: asString(row.title),
      goal: asString(row.goal),
      status: asString(row.status),
      summary: asString(row.summary),
      created_at: asString(row.created_at),
      updated_at: asString(row.updated_at),
    };
  }

  private taskFromRow(row: Record<string, unknown>): Task {
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      thread_id: asString(row.thread_id),
      parent_task_id: (row.parent_task_id as string | null) ?? null,
      task_key: (row.task_key as string | null) ?? null,
      title: asString(row.title),
      objective: asString(row.objective),
      assignee: (row.assignee as string | null) ?? null,
      status: asString(row.status) as TaskStatus,
      priority: Number(row.priority ?? 0),
      acceptance: decodeJson<string[]>(row.acceptance_json as string, []),
      constraints: decodeJson<Record<string, unknown>>(
        row.constraints_json as string,
        {},
      ),
      inputs: decodeJson<unknown[]>(row.inputs_json as string, []),
      budget: decodeJson<Budget>(row.budget_json as string, {}),
      deadline: (row.deadline as string | null) ?? null,
      created_at: asString(row.created_at),
      updated_at: asString(row.updated_at),
    };
  }

  private runFromRow(row: Record<string, unknown>): Run {
    return {
      id: asString(row.id),
      task_id: asString(row.task_id),
      position_id: asString(row.position_id),
      status: asString(row.status),
      session_ref: (row.session_ref as string | null) ?? null,
      context_pack_id: (row.context_pack_id as string | null) ?? null,
      started_at: asString(row.started_at),
      ended_at: (row.ended_at as string | null) ?? null,
      cost: decodeJson(row.cost_json as string, {}),
    };
  }

  private reportFromRow(row: Record<string, unknown>): ReportRecord {
    return {
      id: asString(row.id),
      task_id: asString(row.task_id),
      run_id: asString(row.run_id),
      status: asString(row.status) as ReportStatus,
      summary: asString(row.summary),
      report: decodeJson<Report>(row.report_json as string, {} as Report),
      created_at: asString(row.created_at),
    };
  }

  private decisionFromRow(row: Record<string, unknown>): Decision {
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      thread_id: (row.thread_id as string | null) ?? null,
      task_id: (row.task_id as string | null) ?? null,
      question: asString(row.question),
      options: decodeJson<string[]>(row.options_json as string, []),
      status: asString(row.status) as Decision["status"],
      chosen: (row.chosen as string | null) ?? null,
      rationale: (row.rationale as string | null) ?? null,
      created_at: asString(row.created_at),
      resolved_at: (row.resolved_at as string | null) ?? null,
    };
  }

  private sessionRefFromRow(row: Record<string, unknown>): SessionRef {
    return {
      id: asString(row.id),
      position_id: asString(row.position_id),
      harness_kind: asString(row.harness_kind),
      session_id: asString(row.session_id),
      cwd: asString(row.cwd),
      model: (row.model as string | null) ?? null,
      harness_version: (row.harness_version as string | null) ?? null,
      context_hash: asString(row.context_hash),
      last_used_at: asString(row.last_used_at),
      expires_at: (row.expires_at as string | null) ?? null,
      status: asString(row.status),
    };
  }

  private eventFromRow(row: Record<string, unknown>): EventRecord {
    return {
      id: asString(row.id),
      run_id: (row.run_id as string | null) ?? null,
      task_id: (row.task_id as string | null) ?? null,
      seq: Number(row.seq ?? 0),
      type: asString(row.type),
      payload: decodeJson(row.payload_json as string, {}),
      created_at: asString(row.created_at),
    };
  }
}
