import type { TaskStatus } from "./schema";

const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["assigned", "cancelled"],
  assigned: ["running", "queued", "cancelled", "waiting_approval"],
  running: [
    "review",
    "waiting_input",
    "waiting_approval",
    "blocked",
    "failed",
    "done",
    "cancelled",
  ],
  waiting_input: ["running", "blocked", "failed", "cancelled"],
  waiting_approval: ["running", "queued", "blocked", "failed", "cancelled"],
  review: ["done", "blocked", "failed", "running"],
  done: ["running", "cancelled"],
  blocked: ["queued", "running", "failed", "cancelled"],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export const TERMINAL_STATUSES: TaskStatus[] = [
  "done",
  "blocked",
  "failed",
  "cancelled",
  "waiting_approval",
];

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
