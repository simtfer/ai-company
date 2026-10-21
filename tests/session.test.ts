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
  readonly cwds: string[] = [];

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
    this.cwds.push(input.cwd);
    onEvent?.({ type: "status", status: "started" });
    return this.result(input, "started fresh");
  }

  async resume(
    sessionId: string,
    input: RunInput,
    onEvent?: (event: HarnessEvent) => void,
  ): Promise<HarnessRunResult> {
    this.resumeCalls += 1;
    this.cwds.push(input.cwd);
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

function createTaskFor(assignee = "session-1") {
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
        assignee,
        priority: 0,
      },
    ],
  });
  return plan.tasks[0];
}

function createTask() {
  return createTaskFor();
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

  it("reuses one session and one cwd for two different tasks", async () => {
    const plan = service.createPlan({
      title: "two tasks",
      goal: "same employee session",
      tasks: [
        {
          key: "first",
          title: "first",
          objective: "first",
          acceptance: ["done"],
          depends_on: [],
          assignee: "session-1",
          priority: 1,
        },
        {
          key: "second",
          title: "second",
          objective: "second",
          acceptance: ["done"],
          depends_on: ["first"],
          assignee: "session-1",
          priority: 0,
        },
      ],
    });
    service.assignAll(plan.thread.id);
    await service.runReady(plan.thread.id);

    expect(adapter.startCalls).toBe(1);
    expect(adapter.resumeCalls).toBe(1);
    expect(new Set(adapter.cwds)).toEqual(
      new Set([join(directory, "workspace")]),
    );
    expect(
      plan.tasks.every(
        (task) => service.store.getTask(task.id)?.status === "done",
      ),
    ).toBe(true);
  });

  it("gives a new position a new cwd and a new session", async () => {
    expect(() =>
      service.hirePosition({
        name: "session-duplicate",
        role: "engineer",
        harness_kind: "session-test",
        workspace: join(directory, "workspace"),
      }),
    ).toThrow(/already owned/);
    const secondWorkspace = join(directory, "workspace-2");
    service.hirePosition({
      name: "session-2",
      role: "engineer",
      harness_kind: "session-test",
      model: "mock-model",
      workspace: secondWorkspace,
    });
    const task = createTaskFor("session-2");
    service.assignTask(task.id);
    await service.runReady(service.store.getTask(task.id)?.thread_id);

    expect(adapter.startCalls).toBe(1);
    expect(adapter.resumeCalls).toBe(0);
    expect(adapter.cwds).toEqual([secondWorkspace]);
  });

  it("blocks instead of starting a fresh session when resume expires", async () => {
    const task = createTask();
    service.assignTask(task.id);
    await service.runReady(service.store.getTask(task.id)?.thread_id);
    adapter.expireResume = true;

    const result = await service.continueTask(task.id, "more work");
    expect(adapter.resumeCalls).toBe(1);
    expect(adapter.startCalls).toBe(1);
    expect(result.report.status).toBe("blocked");
    expect(result.report.summary).toContain("Sticky session lost");
    expect(
      service.store
        .listEventsForTask(task.id)
        .some((event) => event.type === "session.lost"),
    ).toBe(true);
    expect(
      service.store.getSessionRef(
        service.store.getPositionByName("session-1")!.id,
      )?.status,
    ).toBe("lost");
  });
});
