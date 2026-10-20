import { execFileSync } from "node:child_process";
import type { Report } from "../domain/schema";
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

export interface ClaudeCodeAdapterOptions {
  command?: string;
  commandArgs?: string[];
  model?: string;
  permissionMode?: string;
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
  if (name === "Bash" || name === "BashTool") return "high";
  if (name === "Write" || name === "Edit" || name === "MultiEdit") return "medium";
  return "low";
}

function looksLikeExpiredSession(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("session") &&
    (lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("expired"))
  );
}

/**
 * Experimental Claude Code adapter.
 *
 * The CLI is not installed on this machine, so this adapter is contract-tested
 * with a mock process rather than a live Claude Code binary. The flags follow
 * the non-interactive stream-json interface and are isolated here for easy
 * adjustment when the real binary is available.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly kind = "claude-code";
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly model?: string;
  private readonly permissionMode: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.command = options.command ?? "claude";
    this.commandArgs = options.commandArgs ?? [];
    this.model = options.model;
    this.permissionMode = options.permissionMode ?? "acceptEdits";
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
    const args = [...this.commandArgs];
    if (sessionId) args.push("--resume", sessionId);
    const model = input.position.model ?? this.model;
    if (model) args.push("--model", model);
    args.push(
      "-p",
      buildEmployeePrompt(input.task, input.context, input.instruction),
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      this.permissionMode,
    );

    const events: HarnessEvent[] = [];
    let finalText = "";
    let usage: HarnessUsage = {};
    let discoveredSession = sessionId;
    let adapterError = "";

    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit({ type: "status", status: "starting", message: "claude-code" });

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
        discoveredSession =
          asString(event.session_id) ??
          asString(event.sessionId) ??
          discoveredSession;
        const type = asString(event.type);
        if (type === "system") {
          const subtype = asString(event.subtype);
          if (subtype) emit({ type: "status", status: subtype });
          return;
        }
        if (type === "assistant") {
          const message = asRecord(event.message);
          const content = Array.isArray(message?.content)
            ? message.content
            : [];
          for (const block of content) {
            const row = asRecord(block);
            if (!row) continue;
            if (asString(row.type) === "text") {
              const text = asString(row.text);
              if (text) {
                finalText += text;
                emit({ type: "text", text });
              }
            }
            if (asString(row.type) === "tool_use") {
              const name = asString(row.name) ?? "tool";
              emit({
                type: "tool",
                name,
                input: row.input,
                risk: toolRisk(name),
              });
            }
          }
          return;
        }
        if (type === "result") {
          const text = asString(event.result);
          if (text && !finalText.includes(text)) finalText += text;
          const cost = asNumber(event.total_cost_usd);
          const usageRecord = asRecord(event.usage);
          const inputTokens =
            asNumber(usageRecord?.input_tokens) ??
            asNumber(usageRecord?.prompt_tokens);
          const outputTokens =
            asNumber(usageRecord?.output_tokens) ??
            asNumber(usageRecord?.completion_tokens);
          if (cost !== undefined || inputTokens !== undefined) {
            usage = {
              tokens:
                (inputTokens ?? 0) + (outputTokens ?? 0) || usage.tokens,
              cost_usd: cost ?? usage.cost_usd,
            };
            emit({
              type: "usage",
              tokens: usage.tokens,
              cost_usd: usage.cost_usd,
              session_id: discoveredSession,
            });
          }
          if (event.is_error === true) {
            adapterError = text ?? "claude-code result is_error";
            emit({ type: "error", message: adapterError });
          }
        }
        if (type === "error") {
          adapterError =
            asString(event.message) ?? "claude-code reported an error";
          emit({ type: "error", message: adapterError });
        }
      },
    });

    if (
      sessionId &&
      result.code !== 0 &&
      looksLikeExpiredSession(`${result.stderr}\n${finalText}\n${adapterError}`)
    ) {
      throw new SessionExpiredError(
        `claude-code session ${sessionId} is no longer usable`,
      );
    }

    const failed =
      result.code !== 0 || result.timedOut || Boolean(adapterError);
    const summary = failed
      ? [
          result.timedOut ? "claude-code 执行超时。" : "claude-code 执行失败。",
          adapterError,
          result.stderr.slice(-2000),
          finalText.slice(-1000),
        ]
          .filter(Boolean)
          .join("\n")
      : finalText.trim() || "claude-code 完成，但没有返回文本摘要。";

    const report: Report = reportFor(
      input,
      failed ? "failed" : "done",
      summary.slice(0, 8000),
      {
        evidence: [
          {
            kind: "adapter",
            name: "claude-code",
            exit_code: result.code,
            timed_out: result.timedOut,
            session_id: discoveredSession,
          },
        ],
        risks: failed
          ? [result.stderr.slice(-500) || "claude-code 返回非零退出码"]
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
