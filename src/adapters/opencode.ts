import { execFileSync } from "node:child_process";
import type { Report } from "../domain/schema";
import { findOpencodeCommand } from "./discovery";
import { runJsonlProcess } from "./process";
import { buildEmployeePrompt } from "./prompt";
import {
  SessionExpiredError,
  reportFor,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunResult,
  type HarnessUsage,
  type RunInput,
} from "./types";

export interface OpencodeAdapterOptions {
  command?: string;
  commandArgs?: string[];
  model?: string;
  defaultTimeoutMs?: number;
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null
    ? (value as AnyRecord)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function toolRisk(name: string): "low" | "medium" | "high" {
  if (name === "bash" || name === "shell" || name === "delete") return "high";
  if (name === "write" || name === "edit" || name === "patch") return "medium";
  return "low";
}

function extractSessionId(event: AnyRecord): string | undefined {
  const direct = asString(event.sessionID);
  if (direct) return direct;
  const part = asRecord(event.part);
  return part ? asString(part.sessionID) : undefined;
}

function extractText(event: AnyRecord): string | undefined {
  const part = asRecord(event.part);
  if (!part) return undefined;
  if (asString(part.type) === "text") return asString(part.text);
  return undefined;
}

function extractTool(event: AnyRecord): HarnessEvent | null {
  if (asString(event.type) !== "tool_use") return null;
  const part = asRecord(event.part);
  if (!part) return null;
  const name = asString(part.tool) ?? "tool";
  const state = asRecord(part.state);
  return {
    type: "tool",
    name,
    input: state?.input,
    output:
      typeof state?.output === "string"
        ? state.output.slice(0, 4000)
        : undefined,
    status: asString(state?.status),
    risk: toolRisk(name),
  };
}

function usageFrom(event: AnyRecord): HarnessUsage | null {
  if (asString(event.type) !== "step_finish") return null;
  const part = asRecord(event.part);
  const tokens = asRecord(part?.tokens);
  const total = asNumber(tokens?.total);
  const cost = asNumber(part?.cost);
  if (total === undefined && cost === undefined) return null;
  return { tokens: total, cost_usd: cost };
}

function looksLikeExpiredSession(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    (lower.includes("session") && lower.includes("not found")) ||
    (lower.includes("session") && lower.includes("does not exist")) ||
    (lower.includes("invalid session") && lower.includes("session"))
  );
}

export class OpencodeAdapter implements HarnessAdapter {
  readonly kind = "opencode";
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly model: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpencodeAdapterOptions = {}) {
    this.command = options.command ?? findOpencodeCommand() ?? "opencode";
    this.commandArgs = options.commandArgs ?? [];
    this.model = options.model ?? "deepseek/deepseek-flash";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
  }

  async probe(): Promise<HarnessCapabilities> {
    try {
      const version = execFileSync(this.command, ["--version"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      }).trim();
      return {
        kind: this.kind,
        supports_resume: true,
        supports_streaming: true,
        version,
      };
    } catch (error) {
      return {
        kind: this.kind,
        supports_resume: false,
        supports_streaming: false,
        version: `unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async start(
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    return this.run(undefined, input, onEvent);
  }

  async resume(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    return this.run(sessionId, input, onEvent);
  }

  private async run(
    sessionId: string | undefined,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    const model = input.position.model || this.model;
    const args = [
      ...this.commandArgs,
      "run",
      "--format",
      "json",
      "--model",
      model,
      "--title",
      input.task.title,
    ];
    if (sessionId) {
      args.push("--session", sessionId);
    }
    args.push(buildEmployeePrompt(input.task, input.context, input.instruction));

    const events: HarnessEvent[] = [];
    let finalText = "";
    let usage: HarnessUsage = {};
    let discoveredSession = sessionId;
    let adapterError = "";

    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent?.(event);
    };

    emit({ type: "status", status: "starting", message: `opencode ${model}` });
    const result = await runJsonlProcess(this.command, args, {
      cwd: input.cwd,
      timeoutMs:
        input.timeout_ms ??
        (input.task.budget.minutes
          ? input.task.budget.minutes * 60_000
          : this.defaultTimeoutMs),
      signal: input.signal,
      onStderr: (chunk) => {
        if (chunk.trim()) {
          emit({ type: "status", status: "stderr", message: chunk.slice(0, 2000) });
        }
      },
      onLine: (value) => {
        const event = asRecord(value);
        if (!event) return;
        discoveredSession = extractSessionId(event) ?? discoveredSession;
        const text = extractText(event);
        if (text) {
          finalText += text;
          emit({ type: "text", text });
        }
        const tool = extractTool(event);
        if (tool) emit(tool);
        const eventUsage = usageFrom(event);
        if (eventUsage) {
          usage = {
            tokens: (usage.tokens ?? 0) + (eventUsage.tokens ?? 0),
            cost_usd: (usage.cost_usd ?? 0) + (eventUsage.cost_usd ?? 0),
          };
          emit({
            type: "usage",
            tokens: eventUsage.tokens,
            cost_usd: eventUsage.cost_usd,
            session_id: discoveredSession,
          });
        }
        if (asString(event.type) === "error") {
          adapterError =
            asString(asRecord(event.part)?.message) ??
            asString(event.message) ??
            "opencode reported an error";
          emit({ type: "error", message: adapterError });
        }
      },
    });

    emit({ type: "status", status: result.timedOut ? "timeout" : "finished" });

    if (
      sessionId &&
      result.code !== 0 &&
      looksLikeExpiredSession(`${result.stderr}\n${finalText}\n${adapterError}`)
    ) {
      throw new SessionExpiredError(
        `opencode session ${sessionId} is no longer usable`,
      );
    }

    const failed =
      result.code !== 0 || result.timedOut || Boolean(adapterError);
    const summary = failed
      ? [
          result.timedOut ? "opencode 执行超时。" : "opencode 执行失败。",
          adapterError,
          result.stderr.slice(-2000),
          finalText.slice(-1000),
        ]
          .filter(Boolean)
          .join("\n")
      : finalText.trim() || "opencode 完成，但没有返回文本摘要。";

    const report: Report = reportFor(
      input,
      failed ? "failed" : "done",
      summary.slice(0, 8000),
      {
        branch: asString(asRecord(input.context.workspace)?.branch),
        evidence: [
          {
            kind: "adapter",
            name: "opencode",
            exit_code: result.code,
            timed_out: result.timedOut,
            session_id: discoveredSession,
          },
        ],
        risks: failed
          ? [result.stderr.slice(-500) || "opencode 返回非零退出码"]
          : [],
        next: failed ? ["由 CEO 决定重试或转派"] : ["由 CEO 验收"],
      },
    );

    return {
      report,
      session_id: discoveredSession,
      usage,
      events,
      exit_code: result.code,
      stderr: result.stderr,
    };
  }
}
