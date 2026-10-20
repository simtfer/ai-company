import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeAdapter } from "../src/adapters/opencode";
import type { ContextPack, Position, Task } from "../src/domain/schema";
import type { RunInput } from "../src/adapters/types";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-adapter-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function input(): RunInput {
  const task = {
    id: "t_test",
    company_id: "c_main",
    thread_id: "th_test",
    parent_task_id: null,
    task_key: "test",
    title: "test task",
    objective: "test objective",
    assignee: "worker",
    status: "assigned",
    priority: 0,
    acceptance: ["done"],
    constraints: {},
    inputs: [],
    budget: {},
    deadline: null,
    lease_owner: null,
    lease_expires_at: null,
    lease_token: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Task;
  const position = {
    id: "p_test",
    company_id: "c_main",
    node_id: "n_local",
    name: "worker",
    role: "engineer",
    harness_kind: "opencode",
    model: "mock/model",
    status: "idle",
    workspace: directory,
    policy: {},
    budget: {},
    created_at: new Date().toISOString(),
  } as Position;
  const context = {
    schema: "context_pack/v1",
    context_hash: "hash",
    position,
    thread: {},
    task,
    memory: [],
    related_reports: [],
    session_ref: null,
    workspace: { path: directory, branch: "task/t_test" },
    instruction: "do it",
    changed_since_last_run: [],
    do_not_redo: [],
  } as ContextPack;
  return {
    run_id: "r_test",
    task,
    position,
    context,
    cwd: directory,
    instruction: "do it",
    timeout_ms: 10_000,
  };
}

describe("OpencodeAdapter", () => {
  it("parses JSONL events, session, text and usage", async () => {
    const adapter = new OpencodeAdapter({
      command: process.execPath,
      commandArgs: [
        join(process.cwd(), "tests", "fixtures", "mock-opencode.mjs"),
      ],
      model: "mock/model",
    });
    const events: string[] = [];
    const result = await adapter.start(input(), (event) => {
      events.push(event.type);
    });

    expect(result.report.status).toBe("done");
    expect(result.report.summary).toContain("mock done");
    expect(result.session_id).toBe("ses_mock");
    expect(result.usage?.tokens).toBe(42);
    expect(result.usage?.cost_usd).toBeCloseTo(0.001);
    expect(events).toContain("text");
    expect(events).toContain("tool");
    expect(events).toContain("usage");
  });

  it("resumes an existing session", async () => {
    const adapter = new OpencodeAdapter({
      command: process.execPath,
      commandArgs: [
        join(process.cwd(), "tests", "fixtures", "mock-opencode.mjs"),
      ],
      model: "mock/model",
    });
    const result = await adapter.resume("ses_existing", input());
    expect(result.session_id).toBe("ses_existing");
    expect(result.report.summary).toContain("resumed mock done");
    expect(result.usage?.tokens).toBe(21);
  });
});
