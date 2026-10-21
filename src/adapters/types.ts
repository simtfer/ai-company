import type { ContextPack, Position, Report, Task } from "../domain/schema";

export interface HarnessCapabilities {
  kind: string;
  supports_resume: boolean;
  supports_streaming: boolean;
  version?: string;
}

export interface ApprovalRequest {
  tool_name: string;
  input: Record<string, unknown>;
  reason?: string;
  blocked_path?: string;
  suggestions?: unknown;
}

export interface ApprovalDecision {
  allow: boolean;
  message?: string;
}

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export interface RunInput {
  run_id: string;
  task: Task;
  position: Position;
  context: ContextPack;
  cwd: string;
  instruction: string;
  timeout_ms?: number;
  signal?: AbortSignal;
  approval_handler?: ApprovalHandler;
}

export type HarnessEvent =
  | { type: "status"; status: string; message?: string }
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      input?: unknown;
      output?: string;
      status?: string;
      risk?: "low" | "medium" | "high";
    }
  | {
      type: "approval_request";
      action: string;
      risk: "low" | "medium" | "high";
      details?: unknown;
    }
  | {
      type: "usage";
      tokens?: number;
      cost_usd?: number;
      session_id?: string;
    }
  | { type: "error"; message: string };

export interface HarnessUsage {
  tokens?: number;
  cost_usd?: number;
}

export interface HarnessRunResult {
  report: Report;
  session_id?: string;
  usage?: HarnessUsage;
  events: HarnessEvent[];
  exit_code?: number | null;
  stderr?: string;
}

export interface HarnessAdapter {
  readonly kind: string;
  probe(): Promise<HarnessCapabilities>;
  start(
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult>;
  resume?(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult>;
}

export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

export function reportFor(
  input: RunInput,
  status: Report["status"],
  summary: string,
  options: {
    branch?: string;
    changes?: unknown[];
    evidence?: unknown[];
    risks?: string[];
    next?: string[];
    decisions?: string[];
    decision?: Report["decision"];
  } = {},
): Report {
  const branch = options.branch ?? `task/${input.task.id}`;
  return {
    schema: "report/v1",
    task_id: input.task.id,
    status,
    summary,
    changes: options.changes ?? [],
    evidence: options.evidence ?? [],
    handoff: {
      state: summary,
      branch,
      open_issues: options.risks ?? [],
      next_steps: options.next ?? [],
      decisions_needed: options.decisions ?? [],
    },
    risks: options.risks ?? [],
    next: options.next ?? [],
    ...(options.decision ? { decision: options.decision } : {}),
  };
}
