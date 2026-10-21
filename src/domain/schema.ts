import { z } from "zod";

export const MAIN_COMPANY_ID = "c_main";
export const LOCAL_NODE_ID = "n_local";

export const TaskStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "waiting_input",
  "waiting_approval",
  "review",
  "done",
  "blocked",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PositionStatusSchema = z.enum([
  "idle",
  "busy",
  "waiting_input",
  "waiting_approval",
  "paused",
  "offline",
  "fired",
]);
export type PositionStatus = z.infer<typeof PositionStatusSchema>;

export const ReportStatusSchema = z.enum([
  "done",
  "blocked",
  "needs_decision",
  "failed",
]);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const BudgetSchema = z.object({
  minutes: z.number().positive().optional(),
  usd: z.number().nonnegative().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const PlanTaskInputSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  objective: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  depends_on: z.array(z.string()).default([]),
  assignee: z.string().min(1).optional(),
  priority: z.number().int().default(0),
  max_retries: z.number().int().nonnegative().optional(),
  constraints: z.any().optional(),
  budget: BudgetSchema.optional(),
  deadline: z.string().optional(),
});
export type PlanTaskInput = z.infer<typeof PlanTaskInputSchema>;

export const CreatePlanInputSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  thread_id: z.string().optional(),
  tasks: z.array(PlanTaskInputSchema).min(1),
});
export type CreatePlanInput = z.infer<typeof CreatePlanInputSchema>;

export const HandoffSchema = z.object({
  state: z.string(),
  branch: z.string().optional(),
  open_issues: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  decisions_needed: z.array(z.string()).default([]),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const ReportDecisionSchema = z.object({
  question: z.string(),
  options: z.array(z.string()).min(1),
});
export type ReportDecision = z.infer<typeof ReportDecisionSchema>;

export const ReportSchema = z.object({
  schema: z.literal("report/v1"),
  task_id: z.string(),
  status: ReportStatusSchema,
  summary: z.string(),
  changes: z.array(z.any()).default([]),
  evidence: z.array(z.any()).default([]),
  handoff: HandoffSchema,
  risks: z.array(z.string()).default([]),
  next: z.array(z.string()).default([]),
  decision: ReportDecisionSchema.optional(),
});
export type Report = z.infer<typeof ReportSchema>;

export const HirePositionInputSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  harness_kind: z.string().min(1).default("fake"),
  model: z.string().optional(),
  workspace: z.string().optional(),
  node_id: z.string().optional(),
  budget: BudgetSchema.optional(),
  policy: z.record(z.string(), z.unknown()).optional(),
});
export type HirePositionInput = z.infer<typeof HirePositionInputSchema>;

export const DecisionRequestInputSchema = z.object({
  task_id: z.string().min(1),
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
});
export type DecisionRequestInput = z.infer<typeof DecisionRequestInputSchema>;

export const ContextPackSchema = z.object({
  schema: z.literal("context_pack/v1"),
  context_hash: z.string(),
  position: z.any(),
  thread: z.any(),
  task: z.any(),
  memory: z.any(),
  related_reports: z.array(z.any()),
  session_ref: z.any().nullable(),
  workspace: z.any(),
  instruction: z.string(),
  changed_since_last_run: z.array(z.string()),
  do_not_redo: z.array(z.string()),
});
export type ContextPack = z.infer<typeof ContextPackSchema>;

export interface Company {
  id: string;
  name: string;
  handbook: string;
  policy: Record<string, unknown>;
  budget: Record<string, unknown>;
  created_at: string;
}

export interface Node {
  id: string;
  company_id: string;
  name: string;
  os: string;
  status: string;
  capabilities: Record<string, unknown>;
  last_seen_at: string;
  kind: "local" | "remote";
  workspace_root: string | null;
  drain: boolean;
  revoked_at: string | null;
  registered_at: string | null;
}

export interface Position {
  id: string;
  company_id: string;
  node_id: string;
  name: string;
  role: string;
  harness_kind: string;
  model: string | null;
  status: PositionStatus;
  workspace: string;
  policy: Record<string, unknown>;
  budget: Record<string, unknown>;
  created_at: string;
}

export interface Thread {
  id: string;
  company_id: string;
  title: string;
  goal: string;
  status: string;
  summary: string;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: string;
  company_id: string;
  thread_id: string;
  parent_task_id: string | null;
  task_key: string | null;
  title: string;
  objective: string;
  assignee: string | null;
  status: TaskStatus;
  priority: number;
  acceptance: string[];
  constraints: Record<string, unknown>;
  inputs: unknown[];
  budget: Budget;
  deadline: string | null;
  attempts: number;
  max_retries: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: string;
  task_id: string;
  position_id: string;
  status: string;
  session_ref: string | null;
  context_pack_id: string | null;
  node_id: string | null;
  lease_token: string | null;
  started_at: string;
  ended_at: string | null;
  start_commit?: string | null;
  cost: Record<string, unknown>;
  tokens: number;
  cost_usd: number;
}

export interface MergeQueueEntry {
  id: string;
  company_id: string;
  task_id: string;
  review_task_id: string | null;
  repo: string | null;
  branch: string | null;
  commit: string | null;
  merge_commit: string | null;
  status: "pending_review" | "ready" | "merged" | "rejected";
  created_at: string;
  updated_at: string;
}

export interface ReportRecord {
  id: string;
  task_id: string;
  run_id: string;
  status: ReportStatus;
  summary: string;
  report: Report;
  created_at: string;
}

export interface Decision {
  id: string;
  company_id: string;
  thread_id: string | null;
  task_id: string | null;
  question: string;
  options: string[];
  status: "open" | "resolved" | "cancelled";
  chosen: string | null;
  rationale: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface SessionRef {
  id: string;
  position_id: string;
  harness_kind: string;
  session_id: string;
  cwd: string;
  model: string | null;
  harness_version: string | null;
  context_hash: string;
  last_used_at: string;
  expires_at: string | null;
  status: string;
}

export interface MemoryEntry {
  position_id: string;
  key: string;
  value: unknown;
  updated_at: string;
}

export interface EventRecord {
  id: string;
  run_id: string | null;
  task_id: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ArtifactRecord {
  id: string;
  task_id: string;
  run_id: string | null;
  kind: string;
  uri: string;
  sha256: string | null;
  meta: Record<string, unknown>;
  created_at: string;
}

export const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  "done",
  "blocked",
  "failed",
  "cancelled",
  "waiting_approval",
];
