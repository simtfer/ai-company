import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyService } from "../src/service/company-service";
import { ClaudeSdkAdapter } from "../src/adapters/claude-sdk";

let directory: string;
let service: CompanyService;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-approval-"));
});

afterEach(() => {
  service?.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("live tool approval bridge", () => {
  it("pauses a Claude tool call until a human decision resolves it", async () => {
    let permissionResult: any = null;
    const queryFn = async function* (params: any) {
      permissionResult = await params.options.canUseTool(
        "Bash",
        { command: "echo hello" },
        { decisionReason: "test requires approval" },
      );
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "approved and done" }],
        },
      };
      yield {
        type: "result",
        result: "approved and done",
        total_cost_usd: 0.001,
        usage: { input_tokens: 10, output_tokens: 5 },
        session_id: "sdk-session",
        is_error: false,
      };
    };

    service = new CompanyService({
      dbPath: join(directory, "company.db"),
      fakeDelayMs: 0,
      approvalTimeoutMs: 5_000,
      adapters: [new ClaudeSdkAdapter({ queryFn })],
    });
    service.hirePosition({
      name: "sdk-1",
      role: "engineer",
      harness_kind: "claude-sdk",
      workspace: join(directory, "workspace"),
    });
    const plan = service.createPlan({
      title: "live approval",
      goal: "approval",
      tasks: [
        {
          key: "work",
          title: "run tool",
          objective: "run a tool",
          acceptance: ["done"],
          depends_on: [],
          assignee: "sdk-1",
          priority: 0,
        },
      ],
    });
    service.assignAll(plan.thread.id);

    const run = service.runReady(plan.thread.id);
    let decision = service.store.listOpenDecisions()[0];
    for (let i = 0; i < 50 && !decision; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      decision = service.store.listOpenDecisions()[0];
    }
    expect(decision).toBeDefined();
    expect(decision?.options).toEqual(["允许", "拒绝"]);
    service.resolveDecision(decision!.id, "允许", "approved in test");

    const results = await run;
    expect(results).toHaveLength(1);
    expect(results[0].report.status).toBe("done");
    expect(results[0].report.summary).toContain("approved and done");
    expect(permissionResult).toMatchObject({ behavior: "allow" });
  });
});
