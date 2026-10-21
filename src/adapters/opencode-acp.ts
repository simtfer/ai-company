import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import type { Report } from "../domain/schema";
import { findOpencodeCommand } from "./discovery";
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

export interface OpencodeAcpAdapterOptions {
  command?: string;
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

function toolRisk(kind: string | undefined, name: string): "low" | "medium" | "high" {
  if (kind === "execute" || kind === "delete") return "high";
  if (kind === "edit" || name === "write" || name === "edit") return "medium";
  return "low";
}

/**
 * opencode through ACP (Agent Client Protocol). ACP exposes
 * `session/request_permission`, so a tool can pause before execution and wait
 * for a human decision, unlike `opencode run --format json`.
 */
export class OpencodeAcpAdapter implements HarnessAdapter {
  readonly kind = "opencode-acp";
  private readonly command: string;
  private readonly model: string;
  private readonly defaultTimeoutMs: number;

  constructor(options: OpencodeAcpAdapterOptions = {}) {
    this.command = options.command ?? findOpencodeCommand() ?? "opencode";
    this.model = options.model ?? "deepseek/deepseek-flash";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
  }

  async probe(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      supports_resume: false,
      supports_streaming: true,
      version: "opencode-acp",
    };
  }

  async start(
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    const events: HarnessEvent[] = [];
    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    let finalText = "";
    let sessionId: string | undefined;
    let usage: HarnessUsage = {};
    let costUsd = 0;
    let failure = "";
    const toolNames = new Map<string, string>();
    const timeoutMs =
      input.timeout_ms ??
      (input.task.budget.minutes
        ? input.task.budget.minutes * 60_000
        : this.defaultTimeoutMs);

    const child = spawn(
      this.command,
      ["acp", "--cwd", input.cwd],
      {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...harnessEnvironment(),
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            model: input.position.model || this.model,
            permission: {
              bash: "ask",
              edit: "ask",
              webfetch: "ask",
            },
          }),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (String(chunk).trim()) stderr.push(String(chunk));
    });

    const app = client({ name: "ai-company" })
      .onRequest("session/request_permission", async (context) => {
        const params = context.params;
        const toolCall = params.toolCall;
        const rawInput = asRecord(toolCall.rawInput) ?? {};
        const name =
          asString(toolCall.name) ??
          asString(toolCall.title) ??
          asString(toolCall.kind) ??
          "tool";
        toolNames.set(toolCall.toolCallId, name);
        const request: ApprovalRequest = {
          tool_name: name,
          input: rawInput,
          reason: asString(toolCall.title),
        };
        emit({
          type: "approval_request",
          action: name,
          risk: toolRisk(asString(toolCall.kind), name),
          details: request,
        });
        if (!input.approval_handler) {
          const allow = params.options.find(
            (option) => option.kind === "allow_once",
          );
          return allow
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } };
        }
        const decision = await input.approval_handler(request);
        const option = decision.allow
          ? params.options.find((candidate) => candidate.kind === "allow_once") ??
            params.options.find((candidate) => candidate.kind === "allow_always")
          : params.options.find((candidate) => candidate.kind === "reject_once") ??
            params.options.find((candidate) => candidate.kind === "reject_always");
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .onNotification("session/update", (context) => {
        const update = asRecord(context.params.update);
        if (!update) return;
        const kind = asString(update.sessionUpdate);
        if (kind === "agent_message_chunk") {
          const content = asRecord(update.content);
          const text = asString(content?.text);
          if (text) {
            finalText += text;
            emit({ type: "text", text });
          }
          return;
        }
        if (kind === "agent_thought_chunk") return;
        if (kind === "usage_update") {
          const cost = asRecord(update.cost);
          costUsd = asNumber(cost?.amount) ?? costUsd;
          return;
        }
        if (kind === "tool_call" || kind === "tool_call_update") {
          const id = asString(update.toolCallId) ?? "tool";
          const name =
            asString(update.name) ??
            asString(update.title) ??
            toolNames.get(id) ??
            "tool";
          toolNames.set(id, name);
          emit({
            type: "tool",
            name,
            input: update.rawInput,
            output:
              typeof update.rawOutput === "string"
                ? update.rawOutput.slice(0, 4000)
                : undefined,
            status: asString(update.status),
            risk: toolRisk(asString(update.kind), name),
          });
        }
      });

    let timer: NodeJS.Timeout | undefined;
    try {
      timer = setTimeout(() => {
        failure = `opencode ACP 超时（${timeoutMs}ms）`;
        child.kill();
      }, timeoutMs);
      timer.unref?.();

      const stream = ndJsonStream(
        Writable.toWeb(child.stdin as Writable) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout as Readable) as unknown as ReadableStream<Uint8Array>,
      );

      await app.connectWith(stream, async (cx) => {
        await cx.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        });
        const session = await cx.request("session/new", {
          cwd: input.cwd,
          mcpServers: [],
        });
        sessionId = session.sessionId;
        emit({ type: "status", status: "session", message: sessionId });
        const response = await cx.request("session/prompt", {
          sessionId,
          prompt: [
            {
              type: "text",
              text: buildEmployeePrompt(
                input.task,
                input.context,
                input.instruction,
              ),
            },
          ],
        });
        const responseRow = asRecord(response) ?? {};
        const responseUsage = asRecord(responseRow.usage);
        usage = {
          tokens:
            asNumber(responseUsage?.totalTokens) ??
            (asNumber(responseUsage?.inputTokens) ?? 0) +
              (asNumber(responseUsage?.outputTokens) ?? 0),
          cost_usd: costUsd,
        };
        const stopReason = asString(responseRow.stopReason);
        if (stopReason === "refusal" || stopReason === "cancelled") {
          failure = `opencode ACP 停止：${stopReason}`;
        }
      });
    } catch (error) {
      failure =
        failure ||
        (error instanceof Error ? error.message : String(error));
      emit({ type: "error", message: failure });
    } finally {
      if (timer) clearTimeout(timer);
      child.kill();
    }

    const report: Report = reportFor(
      input,
      failure ? "failed" : "done",
      failure
        ? `opencode ACP 失败：${failure}\n${finalText.slice(-500)}`
        : finalText.trim() || "opencode ACP 完成，但没有返回文本摘要。",
      {
        evidence: [
          {
            kind: "adapter",
            name: this.kind,
            session_id: sessionId,
            stderr_tail: stderr.join("").slice(-2000),
          },
        ],
        risks: failure ? [failure] : [],
        next: failure ? ["由 CEO 决定重试或转派"] : ["由 CEO 验收"],
      },
    );

    return {
      report,
      session_id: sessionId,
      usage,
      events,
      exit_code: failure ? 1 : 0,
      stderr: failure || stderr.join("").slice(-4000),
    };
  }
}
