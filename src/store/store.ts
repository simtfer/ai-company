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
  MergeQueueEntry,
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
  last_seen_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'local',
  workspace_root TEXT,
  token_hash TEXT,
  drain INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  registered_at TEXT
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
  attempts INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_token TEXT,
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
  node_id TEXT,
  lease_token TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_commit TEXT,
  cost_json TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS enrollment_tokens (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  node_id TEXT
);

CREATE TABLE IF NOT EXISTS merge_queue (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  review_task_id TEXT,
  repo TEXT,
  branch TEXT,
  commit_sha TEXT,
  merge_commit TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
    this.ensureColumn("nodes", "kind", "TEXT NOT NULL DEFAULT 'local'");
    this.ensureColumn("nodes", "workspace_root", "TEXT");
    this.ensureColumn("nodes", "token_hash", "TEXT");
    this.ensureColumn("nodes", "drain", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("nodes", "revoked_at", "TEXT");
    this.ensureColumn("nodes", "registered_at", "TEXT");
    this.ensureColumn("tasks", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "max_retries", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("tasks", "lease_owner", "TEXT");
    this.ensureColumn("tasks", "lease_expires_at", "TEXT");
    this.ensureColumn("tasks", "lease_token", "TEXT");
    this.ensureColumn("runs", "node_id", "TEXT");
    this.ensureColumn("runs", "lease_token", "TEXT");
    this.ensureColumn("runs", "tokens", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "cost_usd", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "start_commit", "TEXT");
    this.ensureColumn("merge_queue", "repo", "TEXT");
    this.ensureColumn("merge_queue", "merge_commit", "TEXT");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  backupTo(path: string): void {
    const escaped = path.replaceAll("'", "''");
    this.db.exec(`VACUUM INTO '${escaped}'`);
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

  updateCompanyBudget(id: string, budget: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE companies SET budget_json = ? WHERE id = ?")
      .run(encodeJson(budget), id);
  }

  updatePositionBudget(id: string, budget: Record<string, unknown>): void {
    this.db
      .prepare("UPDATE positions SET budget_json = ? WHERE id = ?")
      .run(encodeJson(budget), id);
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
      kind: (row.kind as "local" | "remote") ?? "local",
      workspace_root: (row.workspace_root as string | null) ?? null,
      drain: Number(row.drain ?? 0) === 1,
      revoked_at: (row.revoked_at as string | null) ?? null,
      registered_at: (row.registered_at as string | null) ?? null,
    };
  }

  insertNode(node: Node): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO nodes
         (id, company_id, name, os, status, capabilities_json, last_seen_at,
          kind, workspace_root, token_hash, drain, revoked_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.company_id,
        node.name,
        node.os,
        node.status,
        encodeJson(node.capabilities),
        node.last_seen_at,
        node.kind,
        node.workspace_root,
        null,
        node.drain ? 1 : 0,
        node.revoked_at,
        node.registered_at,
      );
  }

  insertRemoteNode(node: Node, tokenHash: string): void {
    this.db
      .prepare(
        `INSERT INTO nodes
         (id, company_id, name, os, status, capabilities_json, last_seen_at,
          kind, workspace_root, token_hash, drain, revoked_at, registered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'remote', ?, ?, 0, NULL, ?)`,
      )
      .run(
        node.id,
        node.company_id,
        node.name,
        node.os,
        node.status,
        encodeJson(node.capabilities),
        node.last_seen_at,
        node.workspace_root,
        tokenHash,
        node.registered_at,
      );
  }

  updateNodeCapabilities(
    id: string,
    capabilities: Record<string, unknown>,
    lastSeenAt = nowIso(),
  ): void {
    this.db
      .prepare(
        "UPDATE nodes SET capabilities_json = ?, last_seen_at = ?, status = 'online' WHERE id = ?",
      )
      .run(encodeJson(capabilities), lastSeenAt, id);
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
      kind: (row.kind as "local" | "remote") ?? "local",
      workspace_root: (row.workspace_root as string | null) ?? null,
      drain: Number(row.drain ?? 0) === 1,
      revoked_at: (row.revoked_at as string | null) ?? null,
      registered_at: (row.registered_at as string | null) ?? null,
    }));
  }

  getNodeByName(name: string): Node | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE name = ?")
      .get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      name: asString(row.name),
      os: asString(row.os),
      status: asString(row.status),
      capabilities: decodeJson(row.capabilities_json as string, {}),
      last_seen_at: asString(row.last_seen_at),
      kind: (row.kind as "local" | "remote") ?? "local",
      workspace_root: (row.workspace_root as string | null) ?? null,
      drain: Number(row.drain ?? 0) === 1,
      revoked_at: (row.revoked_at as string | null) ?? null,
      registered_at: (row.registered_at as string | null) ?? null,
    };
  }

  getNodeByTokenHash(tokenHash: string): Node | null {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE token_hash = ?")
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      name: asString(row.name),
      os: asString(row.os),
      status: asString(row.status),
      capabilities: decodeJson(row.capabilities_json as string, {}),
      last_seen_at: asString(row.last_seen_at),
      kind: (row.kind as "local" | "remote") ?? "local",
      workspace_root: (row.workspace_root as string | null) ?? null,
      drain: Number(row.drain ?? 0) === 1,
      revoked_at: (row.revoked_at as string | null) ?? null,
      registered_at: (row.registered_at as string | null) ?? null,
    };
  }

  updateNodeHeartbeat(
    id: string,
    capabilities?: Record<string, unknown>,
  ): void {
    if (capabilities) {
      this.db
        .prepare(
          "UPDATE nodes SET last_seen_at = ?, status = 'online', capabilities_json = ? WHERE id = ?",
        )
        .run(nowIso(), encodeJson(capabilities), id);
    } else {
      this.db
        .prepare("UPDATE nodes SET last_seen_at = ?, status = 'online' WHERE id = ?")
        .run(nowIso(), id);
    }
  }

  setNodeDrain(id: string, drain: boolean): void {
    this.db
      .prepare("UPDATE nodes SET drain = ? WHERE id = ?")
      .run(drain ? 1 : 0, id);
  }

  revokeNode(id: string): void {
    this.db
      .prepare(
        "UPDATE nodes SET status = 'revoked', revoked_at = ?, token_hash = NULL WHERE id = ?",
      )
      .run(nowIso(), id);
  }

  insertEnrollmentToken(input: {
    id: string;
    company_id: string;
    token_hash: string;
    name: string | null;
    created_at: string;
    expires_at: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO enrollment_tokens
         (id, company_id, token_hash, name, created_at, expires_at, used_at, node_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.company_id,
        input.token_hash,
        input.name,
        input.created_at,
        input.expires_at,
      );
  }

  consumeEnrollmentToken(
    tokenHash: string,
    nodeId: string,
  ): { id: string; name: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT * FROM enrollment_tokens
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, nowIso()) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db
      .prepare(
        "UPDATE enrollment_tokens SET used_at = ?, node_id = ? WHERE id = ?",
      )
      .run(nowIso(), nodeId, asString(row.id));
    return {
      id: asString(row.id),
      name: (row.name as string | null) ?? null,
    };
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
          budget_json, deadline, attempts, max_retries,
          lease_owner, lease_expires_at, lease_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        task.attempts,
        task.max_retries,
        task.lease_owner,
        task.lease_expires_at,
        task.lease_token,
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

  incrementTaskAttempt(id: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET attempts = attempts + 1, status = 'assigned',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  resetTaskForRetry(id: string): void {
    this.db
      .prepare(
        `UPDATE tasks SET status = 'assigned',
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = ? WHERE id = ?`,
      )
      .run(nowIso(), id);
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

  updateTaskLease(
    id: string,
    owner: string,
    token: string,
    expiresAt: string,
  ): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(owner, token, expiresAt, nowIso(), id);
  }

  renewTaskLease(
    taskId: string,
    leaseToken: string,
    expiresAt: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE tasks SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'running' AND lease_token = ?`,
      )
      .run(expiresAt, nowIso(), taskId, leaseToken);
    return Number(result.changes ?? 0) > 0;
  }

  clearTaskLease(id: string): void {
    this.db
      .prepare(
        `UPDATE tasks
         SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(nowIso(), id);
  }

  listTasksAssignedToNode(nodeId: string): Task[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM tasks t
         JOIN positions p ON p.name = t.assignee
         WHERE p.node_id = ? AND t.status = 'assigned'
           AND EXISTS (
             SELECT 1 FROM runs r
             WHERE r.task_id = t.id AND r.node_id = ? AND r.status = 'dispatched'
           )
         ORDER BY t.priority DESC, t.created_at ASC`,
      )
      .all(nodeId, nodeId) as Record<string, unknown>[];
    return rows.map((row) => this.taskFromRow(row));
  }

  claimTaskForNode(
    taskId: string,
    nodeId: string,
    leaseToken: string,
    expiresAt: string,
  ): Task | null {
    const result = this.db
      .prepare(
        `UPDATE tasks
         SET status = 'running', lease_owner = ?, lease_token = ?,
             lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'assigned'
           AND (lease_expires_at IS NULL OR lease_expires_at < ?)
           AND assignee IN (SELECT name FROM positions WHERE node_id = ?)
           AND EXISTS (
             SELECT 1 FROM runs r
             WHERE r.task_id = tasks.id AND r.node_id = ? AND r.status = 'dispatched'
           )`,
      )
      .run(
        leaseToken,
        leaseToken,
        expiresAt,
        nowIso(),
        taskId,
        nowIso(),
        nodeId,
        nodeId,
      );
    if (Number(result.changes ?? 0) === 0) return null;
    return this.getTask(taskId);
  }

  listExpiredLeases(now = nowIso()): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'running' AND lease_expires_at IS NOT NULL
           AND lease_expires_at < ?`,
      )
      .all(now) as Record<string, unknown>[];
    return rows.map((row) => this.taskFromRow(row));
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
         (id, task_id, position_id, status, session_ref, context_pack_id,
          node_id, lease_token, started_at, ended_at, start_commit, cost_json,
          tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.task_id,
        run.position_id,
        run.status,
        run.session_ref,
        run.context_pack_id,
        run.node_id,
        run.lease_token,
        run.started_at,
        run.ended_at,
        run.start_commit ?? null,
        encodeJson(run.cost),
        run.tokens,
        run.cost_usd,
      );
    return run;
  }

  updateRun(
    id: string,
    patch: Partial<
      Pick<
        Run,
        | "status"
        | "ended_at"
        | "cost"
        | "session_ref"
        | "context_pack_id"
        | "node_id"
        | "lease_token"
        | "tokens"
        | "cost_usd"
      >
    >,
  ): void {
    const current = this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    this.db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, cost_json = ?, session_ref = ?,
         context_pack_id = ?, node_id = ?, lease_token = ?, tokens = ?, cost_usd = ?
         WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.ended_at ?? current.ended_at,
        encodeJson(patch.cost ?? current.cost),
        patch.session_ref ?? current.session_ref,
        patch.context_pack_id ?? current.context_pack_id,
        patch.node_id ?? current.node_id,
        patch.lease_token === null
          ? null
          : (patch.lease_token ?? current.lease_token),
        patch.tokens ?? current.tokens,
        patch.cost_usd ?? current.cost_usd,
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

  listRunsForCompany(companyId = MAIN_COMPANY_ID): Run[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM runs r
         JOIN tasks t ON t.id = r.task_id
         WHERE t.company_id = ?
         ORDER BY r.started_at ASC`,
      )
      .all(companyId) as Record<string, unknown>[];
    return rows.map((row) => this.runFromRow(row));
  }

  private runMinutes(run: Run): number {
    if (!run.ended_at) return 0;
    return Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at)) / 60_000;
  }

  companyMinutes(companyId = MAIN_COMPANY_ID): number {
    return this.listRunsForCompany(companyId).reduce(
      (sum, run) => sum + this.runMinutes(run),
      0,
    );
  }

  positionMinutes(positionId: string): number {
    return this.listRunsForCompany()
      .filter((run) => run.position_id === positionId)
      .reduce((sum, run) => sum + this.runMinutes(run), 0);
  }

  taskMinutes(taskId: string): number {
    return this.listRunsForTask(taskId).reduce(
      (sum, run) => sum + this.runMinutes(run),
      0,
    );
  }

  companySpend(companyId = MAIN_COMPANY_ID): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.cost_usd), 0) AS spend FROM runs r
         JOIN tasks t ON t.id = r.task_id WHERE t.company_id = ?`,
      )
      .get(companyId) as { spend: number } | undefined;
    return Number(row?.spend ?? 0);
  }

  positionSpend(positionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM runs WHERE position_id = ?",
      )
      .get(positionId) as { spend: number } | undefined;
    return Number(row?.spend ?? 0);
  }

  taskSpend(taskId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS spend FROM runs WHERE task_id = ?",
      )
      .get(taskId) as { spend: number } | undefined;
    return Number(row?.spend ?? 0);
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

  // ---------- merge queue ----------

  insertMergeQueue(entry: MergeQueueEntry): MergeQueueEntry {
    this.db
      .prepare(
        `INSERT INTO merge_queue
         (id, company_id, task_id, review_task_id, repo, branch, commit_sha,
          merge_commit, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.company_id,
        entry.task_id,
        entry.review_task_id,
        entry.repo,
        entry.branch,
        entry.commit,
        entry.merge_commit,
        entry.status,
        entry.created_at,
        entry.updated_at,
      );
    return entry;
  }

  getMergeQueueEntry(id: string): MergeQueueEntry | null {
    const row = this.db
      .prepare("SELECT * FROM merge_queue WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.mergeQueueFromRow(row) : null;
  }

  listMergeQueue(status?: MergeQueueEntry["status"]): MergeQueueEntry[] {
    const rows = status
      ? (this.db
          .prepare(
            "SELECT * FROM merge_queue WHERE status = ? ORDER BY created_at ASC",
          )
          .all(status) as Record<string, unknown>[])
      : (this.db
          .prepare("SELECT * FROM merge_queue ORDER BY created_at ASC")
          .all() as Record<string, unknown>[]);
    return rows.map((row) => this.mergeQueueFromRow(row));
  }

  updateMergeQueueStatus(id: string, status: MergeQueueEntry["status"]): void {
    this.db
      .prepare("UPDATE merge_queue SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, nowIso(), id);
  }

  markMergeQueueMerged(id: string, mergeCommit: string): void {
    this.db
      .prepare(
        "UPDATE merge_queue SET status = 'merged', merge_commit = ?, updated_at = ? WHERE id = ?",
      )
      .run(mergeCommit, nowIso(), id);
  }

  setMergeQueueReviewTask(id: string, reviewTaskId: string): void {
    this.db
      .prepare(
        "UPDATE merge_queue SET review_task_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(reviewTaskId, nowIso(), id);
  }

  findMergeByReviewTask(reviewTaskId: string): MergeQueueEntry | null {
    const row = this.db
      .prepare("SELECT * FROM merge_queue WHERE review_task_id = ? LIMIT 1")
      .get(reviewTaskId) as Record<string, unknown> | undefined;
    return row ? this.mergeQueueFromRow(row) : null;
  }

  // ---------- memory search ----------

  searchPositionMemory(query: string, limit = 20): Array<Record<string, unknown>> {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT m.position_id, p.name AS position_name, m.key, m.value_json, m.updated_at
         FROM position_memory m
         JOIN positions p ON p.id = m.position_id
         WHERE m.key LIKE ? OR m.value_json LIKE ?
         ORDER BY m.updated_at DESC LIMIT ?`,
      )
      .all(like, like, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      kind: "position_memory",
      position: asString(row.position_name),
      key: asString(row.key),
      value: decodeJson(row.value_json as string, null),
      updated_at: asString(row.updated_at),
    }));
  }

  searchThreads(query: string, limit = 20): Array<Record<string, unknown>> {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT id, title, goal, summary, updated_at FROM threads
         WHERE title LIKE ? OR goal LIKE ? OR summary LIKE ?
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(like, like, like, limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      kind: "thread",
      thread_id: asString(row.id),
      title: asString(row.title),
      summary: asString(row.summary),
      updated_at: asString(row.updated_at),
    }));
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

  updateSessionStatus(positionId: string, status: string): void {
    this.db
      .prepare(
        "UPDATE session_refs SET status = ?, last_used_at = ? WHERE position_id = ?",
      )
      .run(status, nowIso(), positionId);
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

  getContextPack(id: string): unknown | null {
    const row = this.db
      .prepare("SELECT pack_json FROM context_packs WHERE id = ?")
      .get(id) as { pack_json?: string } | undefined;
    return row?.pack_json ? decodeJson(row.pack_json, null) : null;
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
      attempts: Number(row.attempts ?? 0),
      max_retries: Number(row.max_retries ?? 0),
      lease_owner: (row.lease_owner as string | null) ?? null,
      lease_expires_at: (row.lease_expires_at as string | null) ?? null,
      lease_token: (row.lease_token as string | null) ?? null,
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
      node_id: (row.node_id as string | null) ?? null,
      lease_token: (row.lease_token as string | null) ?? null,
      started_at: asString(row.started_at),
      ended_at: (row.ended_at as string | null) ?? null,
      start_commit: (row.start_commit as string | null) ?? null,
      cost: decodeJson(row.cost_json as string, {}),
      tokens: Number(row.tokens ?? 0),
      cost_usd: Number(row.cost_usd ?? 0),
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

  private mergeQueueFromRow(row: Record<string, unknown>): MergeQueueEntry {
    return {
      id: asString(row.id),
      company_id: asString(row.company_id),
      task_id: asString(row.task_id),
      review_task_id: (row.review_task_id as string | null) ?? null,
      repo: (row.repo as string | null) ?? null,
      branch: (row.branch as string | null) ?? null,
      commit: (row.commit_sha as string | null) ?? null,
      merge_commit: (row.merge_commit as string | null) ?? null,
      status: asString(row.status) as MergeQueueEntry["status"],
      created_at: asString(row.created_at),
      updated_at: asString(row.updated_at),
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
