import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyService } from "../src/service/company-service";
import {
  SessionExpiredError,
  reportFor,
  type HarnessAdapter,
  type HarnessCapabilities,
  type HarnessEvent,
  type HarnessRunResult,
  type RunInput,
} from "../src/adapters/types";

class SessionTestAdapter implements HarnessAdapter {
  readonly kind = "session-test";
  startCalls = 0;
  resumeCalls = 0;
  expireResume = false;

  async probe(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      supports_resume: true,
      supports_streaming: true,
      version: "test",
    };
  }

  async start(
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    this.startCalls += 1;
    onEvent?.({ type: "status", status: "started" });
    return this.result(input, "started fresh");
  }

  async resume(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    this.resumeCalls += 1;
    if (this.expireResume) {
      throw new SessionExpiredError("expired for test");
    }
    onEvent?.({ type: "status", status: "resumed" });
    return {
      ...this.result(input, `resumed ${sessionId}`),
      session_id: sessionId,
    };
  }

  private result(input: RunInput, summary: string): HarnessRunResult {
    return {
      report: reportFor(input, "done", summary, {
        next: ["CEO review"],
      }),
      session_id: "ses_test",
      usage: { tokens: 5, cost_usd: 0.001 },
      events: [],
      exit_code: 0,
    };
  }
}

let directory: string;
let service: CompanyService;
let adapter: SessionTestAdapter;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-session-"));
  adapter = new SessionTestAdapter();
  service = new CompanyService({
    dbPath: join(directory, "company.db"),
    fakeDelayMs: 0,
    adapters: [adapter],
  });
  service.hirePosition({
    name: "session-1",
    role: "engineer",
    harness_kind: "session-test",
    model: "mock-model",
    workspace: join(directory, "workspace"),
  });
});

afterEach(() => {
  service.close();
  rmSync(directory, { recursive: true, force: true });
});

function createTask() {
  const plan = service.createPlan({
    title: "session test",
    goal: "verify session manager",
    tasks: [
      {
        key: "work",
        title: "do work",
        objective: "do work",
        acceptance: ["done"],
        depends_on: [],
        assignee: "session-1",
        priority: 0,
      },
    ],
  });
  return plan.tasks[0];
}

describe("session manager", () => {
  it("resumes a valid session on continue", async () => {
    const task = createTask();
    service.assignTask(task.id);
    await service.runReady(service.store.getTask(task.id)?.thread_id);
    expect(adapter.startCalls).toBe(1);

    await service.continueTask(task.id, "more work");
    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.startCalls).toBe(1);
    const reports = service.store.listReportsForTask(task.id);
    expect(reports).toHaveLength(2);
    expect(reports[1].summary).toContain("resumed ses_test");
  });

  it("falls back to a fresh context pack when resume expires", async () => {
    const task = createTask();
    service.assignTask(task.id);
    await service.runReady(service.store.getTask(task.id)?.thread_id);
    adapter.expireResume = true;

    const result = await service.continueTask(task.id, "more work");
    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.startCalls).toBe(2);
    expect(result.report.status).toBe("done");
    expect(result.report.summary).toContain("started fresh");
    expect(
      service.store
        .listEventsForTask(task.id)
        .some((event) => event.type === "session.fallback"),
    ).toBe(true);
  });
});
