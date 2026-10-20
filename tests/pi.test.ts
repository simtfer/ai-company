import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/adapters/pi";
import type { ContextPack, Position, Task } from "../src/domain/schema";
import type { RunInput } from "../src/adapters/types";

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-pi-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function input(): RunInput {
  const task = {
    id: "t_pi",
    company_id: "c_main",
    thread_id: "th_pi",
    parent_task_id: null,
    task_key: "pi",
    title: "pi test",
    objective: "test pi",
    assignee: "pi-test",
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
    id: "p_pi",
    company_id: "c_main",
    node_id: "n_local",
    name: "pi-test",
    role: "engineer",
    harness_kind: "pi",
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
    workspace: {},
    instruction: "test",
    changed_since_last_run: [],
    do_not_redo: [],
  } as ContextPack;
  return {
    run_id: "r_pi",
    task,
    position,
    context,
    cwd: directory,
    instruction: "test",
    timeout_ms: 10_000,
  };
}

describe("PiAdapter", () => {
  it("parses pi JSON events and session id", async () => {
    const adapter = new PiAdapter({
      command: process.execPath,
      commandArgs: [join(process.cwd(), "tests", "fixtures", "mock-pi.mjs")],
      model: "mock/model",
    });
    const result = await adapter.start(input());
    expect(result.report.status).toBe("done");
    expect(result.report.summary).toContain("PI_MOCK mock/model");
    expect(result.session_id).toBeTruthy();
    expect(result.usage?.tokens).toBe(12);
  });
});
