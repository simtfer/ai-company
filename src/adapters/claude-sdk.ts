import type { Report } from "../domain/schema";
import { findClaudeCommand } from "./discovery";
import { harnessEnvironment } from "./env";
import { buildEmployeePrompt } from "./prompt";
import {
  reportFor,
  type ApprovalRequest,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunResult,
  type HarnessUsage,
  type RunInput,
} from "./types";

export interface ClaudeSdkAdapterOptions {
  command?: string;
  defaultTimeoutMs?: number;
  queryFn?: (params: any) => AsyncIterable<any>;
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

/**
 * Claude Code through the official Agent SDK. Unlike the CLI adapter this
 * exposes `canUseTool`, so a tool can pause before execution and wait for a
 * live human decision.
 */
export class ClaudeSdkAdapter implements HarnessAdapter {
  readonly kind = "claude-sdk";
  private readonly command: string;
  private readonly defaultTimeoutMs: number;
  private queryFn: ((params: any) => AsyncIterable<any>) | null;

  constructor(options: ClaudeSdkAdapterOptions = {}) {
    this.command =
      options.command ?? findClaudeCommand() ?? process.execPath;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
    this.queryFn = options.queryFn ?? null;
  }

  private async resolveQuery(): Promise<(params: any) => AsyncIterable<any>> {
    if (this.queryFn) return this.queryFn;
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as {
      query: (params: any) => AsyncIterable<any>;
    };
    this.queryFn = mod.query;
    return this.queryFn;
  }

  async probe(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      supports_resume: true,
      supports_streaming: true,
      version: "claude-agent-sdk",
    };
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
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    let finalText = "";
    let discoveredSession = sessionId;
    let usage: HarnessUsage = {};
    let adapterError = "";
    const abortController = new AbortController();
    const timeoutMs =
      input.timeout_ms ??
      (input.task.budget.minutes
        ? input.task.budget.minutes * 60_000
        : this.defaultTimeoutMs);
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    timer.unref?.();

    emit({
      type: "status",
      status: "starting",
      message: "claude-agent-sdk",
    });

    const canUseTool = async (
      toolName: string,
      toolInput: Record<string, unknown>,
      options: AnyRecord,
    ): Promise<AnyRecord> => {
      const request: ApprovalRequest = {
        tool_name: toolName,
        input: toolInput,
        reason: asString(options?.decisionReason),
        blocked_path: asString(options?.blockedPath),
        suggestions: options?.suggestions,
      };
      emit({
        type: "approval_request",
        action: toolName,
        risk: toolRisk(toolName),
        details: request,
      });
      if (!input.approval_handler) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      const decision = await input.approval_handler(request);
      if (decision.allow) {
        return { behavior: "allow", updatedInput: toolInput };
      }
      return {
        behavior: "deny",
        message: decision.message ?? "Denied by AI Company policy",
        interrupt: false,
      };
    };

    try {
      const queryFn = await this.resolveQuery();
      const stream = queryFn({
        prompt: buildEmployeePrompt(
          input.task,
          input.context,
          input.instruction,
        ),
        options: {
          cwd: input.cwd,
          env: { ...process.env, ...harnessEnvironment() },
          permissionMode: "default",
          pathToClaudeCodeExecutable: this.command,
          ...(sessionId ? { resume: sessionId } : {}),
          abortController,
          canUseTool,
        },
      });

      for await (const message of stream) {
        const row = asRecord(message);
        if (!row) continue;
        const type = asString(row.type);
        if (type === "system") {
          const subtype = asString(row.subtype);
          discoveredSession =
            asString(row.session_id) ?? discoveredSession;
          if (subtype === "init") {
            emit({ type: "status", status: "init", message: discoveredSession });
          }
          if (subtype === "permission_denied") {
            emit({
              type: "tool",
              name: asString(row.tool_name) ?? "tool",
              status: "denied",
              risk: "high",
            });
          }
          continue;
        }
        if (type === "assistant") {
          const messageBody = asRecord(row.message);
          const content = Array.isArray(messageBody?.content)
            ? messageBody.content
            : [];
          for (const block of content) {
            const part = asRecord(block);
            if (!part) continue;
            const partType = asString(part.type);
            if (partType === "text") {
              const text = asString(part.text);
              if (text) {
                finalText += text;
                emit({ type: "text", text });
              }
            }
            if (partType === "tool_use") {
              const name = asString(part.name) ?? "tool";
              emit({
                type: "tool",
                name,
                input: part.input,
                status: "requested",
                risk: toolRisk(name),
              });
            }
          }
          continue;
        }
        if (type === "result") {
          discoveredSession =
            asString(row.session_id) ?? discoveredSession;
          const resultText = asString(row.result);
          if (resultText) finalText = resultText;
          const cost = asNumber(row.total_cost_usd);
          const usageRecord = asRecord(row.usage);
          const inputTokens = asNumber(usageRecord?.input_tokens);
          const outputTokens = asNumber(usageRecord?.output_tokens);
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
          if (row.is_error === true) {
            adapterError = resultText ?? "Claude SDK result is_error";
            emit({ type: "error", message: adapterError });
          }
        }
      }
    } catch (error) {
      adapterError = error instanceof Error ? error.message : String(error);
      emit({ type: "error", message: adapterError });
    } finally {
      clearTimeout(timer);
    }

    const failed = Boolean(adapterError) || abortController.signal.aborted;
    const summary = failed
      ? [
          abortController.signal.aborted ? "Claude SDK 执行超时/中止。" : "Claude SDK 执行失败。",
          adapterError,
          finalText.slice(-1000),
        ]
          .filter(Boolean)
          .join("\n")
      : finalText.trim() || "Claude SDK 完成，但没有返回文本摘要。";

    const report: Report = reportFor(
      input,
      failed ? "failed" : "done",
      summary.slice(0, 8000),
      {
        evidence: [
          {
            kind: "adapter",
            name: this.kind,
            session_id: discoveredSession,
            timed_out: abortController.signal.aborted,
          },
        ],
        risks: failed ? [adapterError || "Claude SDK execution failed"] : [],
        next: failed ? ["由 CEO 决定重试或转派"] : ["由 CEO 验收"],
      },
    );

    return {
      report,
      session_id: discoveredSession,
      usage,
      events,
      exit_code: failed ? 1 : 0,
      stderr: adapterError,
    };
  }
}
