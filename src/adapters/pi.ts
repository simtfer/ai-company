import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Report } from "../domain/schema";
import { findPiSpec } from "./discovery";
import { harnessEnvironment } from "./env";
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

export interface PiAdapterOptions {
  command?: string;
  commandArgs?: string[];
  model?: string;
  tools?: string;
  defaultTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  kind?: string;
  liveApproval?: boolean;
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
  if (name === "bash") return "high";
  if (name === "write" || name === "edit") return "medium";
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

export class PiAdapter implements HarnessAdapter {
  readonly kind: string;
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly model: string;
  private readonly tools: string;
  private readonly defaultTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly liveApproval: boolean;

  constructor(options: PiAdapterOptions = {}) {
    this.kind = options.kind ?? "pi";
    this.liveApproval = options.liveApproval === true;
    const spec = findPiSpec();
    this.command = options.command ?? spec?.command ?? "pi";
    this.commandArgs = options.commandArgs ?? spec?.argsPrefix ?? [];
    this.model =
      options.model ??
      process.env.AIC_PI_MODEL ??
      "qianwenai/deepseek-v4.1-flash-1017";
    this.tools = options.tools ?? "read,bash,edit,write";
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1000;
    this.env = { ...harnessEnvironment(), ...options.env };
  }

  async probe(): Promise<HarnessCapabilities> {
    try {
      const version = execFileSync(this.command, [...this.commandArgs, "--version"], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: { ...process.env, ...this.env },
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
    return this.run(randomUUID(), input, onEvent);
  }

  async resume(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    return this.run(sessionId, input, onEvent);
  }

  private async startApprovalBridge(
    input: RunInput,
    emit: (event: HarnessEvent) => void,
  ): Promise<{
    url: string;
    token: string;
    extensionPath: string;
    close: () => Promise<void>;
  }> {
    const token = randomBytes(16).toString("hex");
    const server = createServer(async (request, response) => {
      if (
        request.method !== "POST" ||
        request.headers["x-aic-token"] !== token
      ) {
        response.writeHead(403).end("forbidden");
        return;
      }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      try {
        const body = JSON.parse(raw) as {
          tool_name?: unknown;
          input?: unknown;
        };
        const name = asString(body.tool_name) ?? "tool";
        const toolInput = asRecord(body.input) ?? {};
        emit({
          type: "approval_request",
          action: name,
          risk: toolRisk(name),
          details: { tool_name: name, input: toolInput },
        });
        const decision = input.approval_handler
          ? await input.approval_handler({ tool_name: name, input: toolInput })
          : { allow: true };
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            allow: decision.allow,
            reason: decision.message ?? "",
          }),
        );
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address() as AddressInfo;
    const dir = join(process.cwd(), ".aic", "extensions");
    mkdirSync(dir, { recursive: true });
    const extensionPath = join(
      dir,
      `pi-approval-${input.run_id.replaceAll(/[^a-zA-Z0-9._-]/g, "-")}.mjs`,
    );
    writeFileSync(
      extensionPath,
      `export default function (pi) {
  pi.on("tool_call", async (event) => {
    const url = process.env.AIC_PI_APPROVAL_URL;
    const token = process.env.AIC_PI_APPROVAL_TOKEN || "";
    if (!url) return;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-aic-token": token },
        body: JSON.stringify({ tool_name: event.toolName, input: event.input }),
      });
      if (!response.ok) {
        return { block: true, reason: "AI Company approval bridge rejected the request" };
      }
      const body = await response.json();
      if (!body.allow) {
        return { block: true, reason: body.reason || "Denied by AI Company policy" };
      }
    } catch (error) {
      return { block: true, reason: "AI Company approval bridge unavailable: " + String(error) };
    }
  });
}
`,
      "utf8",
    );
    return {
      url: `http://127.0.0.1:${address.port}/approve`,
      token,
      extensionPath,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    };
  }

  private async run(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    const model = input.position.model || this.model;
    const allowed = Array.isArray(input.task.constraints.allowed_tools)
      ? input.task.constraints.allowed_tools.map(String)
      : [];
    const args = [
      ...this.commandArgs,
      "-p",
      "--mode",
      "json",
      "--model",
      model,
      "--session-id",
      sessionId,
      "--tools",
      allowed.length > 0 ? allowed.join(",") : this.tools,
      "--no-extensions",
      "--no-mcp",
      "--no-skills",
      "--no-context-files",
      "--approve",
      buildEmployeePrompt(input.task, input.context, input.instruction),
    ];

    const events: HarnessEvent[] = [];
    let finalText = "";
    let usage: HarnessUsage = {};
    let discoveredSession = sessionId;
    let adapterError = "";

    const emit = (event: HarnessEvent): void => {
      events.push(event);
      onEvent?.(event);
    };
    emit({ type: "status", status: "starting", message: `pi ${model}` });

    const bridge =
      this.liveApproval && input.approval_handler
        ? await this.startApprovalBridge(input, emit)
        : null;
    if (bridge) {
      args.splice(args.length - 1, 0, "--extension", bridge.extensionPath);
    }

    let result: Awaited<ReturnType<typeof runJsonlProcess>>;
    try {
      result = await runJsonlProcess(this.command, args, {
      cwd: input.cwd,
      env: {
        ...this.env,
        ...(bridge
          ? {
              AIC_PI_APPROVAL_URL: bridge.url,
              AIC_PI_APPROVAL_TOKEN: bridge.token,
            }
          : {}),
      },
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
        const type = asString(event.type);

        if (type === "session") {
          discoveredSession = asString(event.id) ?? discoveredSession;
          emit({ type: "status", status: "session", message: discoveredSession });
          return;
        }
        if (type === "tool_execution_start") {
          const name = asString(event.toolName) ?? "tool";
          emit({
            type: "tool",
            name,
            input: event.args,
            status: "started",
            risk: toolRisk(name),
          });
          return;
        }
        if (type === "tool_execution_end") {
          const name = asString(event.toolName) ?? "tool";
          emit({
            type: "tool",
            name,
            output: JSON.stringify(event.result ?? "").slice(0, 4000),
            status: event.isError === true ? "error" : "completed",
            risk: toolRisk(name),
          });
          return;
        }
        if (type === "message_end") {
          const message = asRecord(event.message);
          if (!message || asString(message.role) !== "assistant") return;
          const content = Array.isArray(message.content) ? message.content : [];
          let text = "";
          for (const block of content) {
            const row = asRecord(block);
            if (row && asString(row.type) === "text") {
              text += asString(row.text) ?? "";
            }
          }
          if (text) {
            finalText = text;
            emit({ type: "text", text });
          }
          const messageUsage = asRecord(message.usage);
          if (messageUsage) {
            const cost = asRecord(messageUsage.cost);
            const tokens = asNumber(messageUsage.totalTokens);
            const costUsd = asNumber(cost?.total);
            if (tokens !== undefined || costUsd !== undefined) {
              usage = {
                tokens: tokens ?? usage.tokens,
                cost_usd: costUsd ?? usage.cost_usd,
              };
              emit({
                type: "usage",
                tokens: usage.tokens,
                cost_usd: usage.cost_usd,
                session_id: discoveredSession,
              });
            }
          }
          return;
        }
        if (type === "agent_end") {
          emit({ type: "status", status: "agent_end" });
          return;
        }
        if (type === "error") {
          adapterError =
            asString(event.message) ?? "pi reported an error";
          emit({ type: "error", message: adapterError });
        }
      },
    });
    } finally {
      await bridge?.close();
    }

    if (
      result.code !== 0 &&
      looksLikeExpiredSession(`${result.stderr}\n${finalText}\n${adapterError}`)
    ) {
      throw new SessionExpiredError(
        `pi session ${sessionId} is no longer usable`,
      );
    }

    const failed =
      result.code !== 0 || result.timedOut || Boolean(adapterError);
    const summary = failed
      ? [
          result.timedOut ? "pi 执行超时。" : "pi 执行失败。",
          adapterError,
          result.stderr.slice(-2000),
          finalText.slice(-1000),
        ]
          .filter(Boolean)
          .join("\n")
      : finalText.trim() || "pi 完成，但没有返回文本摘要。";

    const report: Report = reportFor(
      input,
      failed ? "failed" : "done",
      summary.slice(0, 8000),
      {
        evidence: [
          {
            kind: "adapter",
            name: "pi",
            exit_code: result.code,
            timed_out: result.timedOut,
            session_id: discoveredSession,
          },
        ],
        risks: failed
          ? [result.stderr.slice(-500) || "pi 返回非零退出码"]
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
