import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { CompanyService } from "../src/service/company-service";
import { FakeHarness } from "../src/adapters/fake";
import { NodeAgent } from "../src/node/agent";
import { startHttpServer } from "../src/http-server";

let directory: string;
let service: CompanyService;
let server: Server;
let baseUrl: string;
const agents: NodeAgent[] = [];

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-m2-"));
  service = new CompanyService({
    dbPath: join(directory, "company.db"),
    fakeDelayMs: 0,
    adapters: [new FakeHarness(0)],
    remoteWaitMs: 5_000,
  });
  server = await startHttpServer({ service, port: 0 });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const agent of agents) {
    await agent.stop();
  }
  agents.length = 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

async function startAgent(name: string, workspaceRoot: string): Promise<NodeAgent> {
  const { token } = service.createEnrollmentToken(name);
  const agent = new NodeAgent({
    serverUrl: baseUrl,
    enrollmentToken: token,
    name,
    workspaceRoot,
    adapters: [new FakeHarness(0)],
    pollMs: 50,
    heartbeatMs: 100,
    leaseMs: 5_000,
  });
  await agent.start();
  agents.push(agent);
  return agent;
}

describe("M2 multi-node", () => {
  it("registers two nodes and dispatches remote tasks with artifact return", async () => {
    const agentA = await startAgent("node-a", join(directory, "node-a"));
    const agentB = await startAgent("node-b", join(directory, "node-b"));
    expect(agentA.nodeId).toBeTruthy();
    expect(agentB.nodeId).toBeTruthy();

    service.hirePosition({
      name: "remote-a",
      role: "worker",
      harness_kind: "fake",
      node_id: agentA.nodeId!,
      workspace: join("workspace", "remote-a"),
    });
    service.hirePosition({
      name: "remote-b",
      role: "worker",
      harness_kind: "fake",
      node_id: agentB.nodeId!,
      workspace: join("workspace", "remote-b"),
    });

    const plan = service.createPlan({
      title: "remote work",
      goal: "two nodes execute tasks",
      tasks: [
        {
          key: "a",
          title: "remote a",
          objective: "work on a",
          acceptance: ["done"],
          depends_on: [],
          assignee: "remote-a",
          priority: 1,
          constraints: { test_command: 'node -e "console.log(\'m2-a\')"' },
        },
        {
          key: "b",
          title: "remote b",
          objective: "work on b",
          acceptance: ["done"],
          depends_on: [],
          assignee: "remote-b",
          priority: 0,
          constraints: { test_command: 'node -e "console.log(\'m2-b\')"' },
        },
      ],
    });
    service.assignAll(plan.thread.id);
    const results = await service.runReady(plan.thread.id);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.report.status === "done")).toBe(true);
    for (const task of plan.tasks) {
      const artifacts = service.store.listArtifactsForTask(task.id);
      expect(artifacts.length).toBeGreaterThan(0);
    }

    const nodes = service.nodeList();
    expect(nodes).toHaveLength(3);
    const remoteA = nodes.find((node) => node.name === "node-a");
    expect(remoteA?.positions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "remote-a" })]),
    );
    expect(remoteA?.online).toBe(true);
  });

  it("requeues a task when its lease expires", () => {
    const plan = service.createPlan({
      title: "lease test",
      goal: "expire a lease",
      tasks: [
        {
          key: "lease",
          title: "leased task",
          objective: "lease",
          acceptance: ["done"],
          depends_on: [],
          assignee: "frontend-1",
          priority: 0,
        },
      ],
    });
    const task = plan.tasks[0];
    service.store.updateTaskStatus(task.id, "assigned");
    service.store.updateTaskStatus(task.id, "running");
    service.store.updateTaskLease(
      task.id,
      "node-x",
      "lease-x",
      "2000-01-01T00:00:00.000Z",
    );
    const expired = service.releaseExpiredLeases();
    expect(expired.map((item) => item.id)).toContain(task.id);
    expect(service.store.getTask(task.id)?.status).toBe("assigned");
  });

  it("drains and revokes nodes, and rejects token reuse", async () => {
    const agentA = await startAgent("node-a", join(directory, "node-a"));
    const agentB = await startAgent("node-b", join(directory, "node-b"));

    service.setNodeDrain(agentB.nodeId!, true);
    expect(
      service.claimTaskForNode(agentB.nodeToken!, 1_000).task,
    ).toBeNull();

    service.revokeNode(agentA.nodeId!);
    expect(() => service.claimTaskForNode(agentA.nodeToken!, 1_000)).toThrow(
      /revoked|Invalid/,
    );

    const enrollment = service.createEnrollmentToken("once");
    service.registerNode({
      token: enrollment.token,
      name: "node-once",
      workspace_root: join(directory, "node-once"),
    });
    expect(() =>
      service.registerNode({
        token: enrollment.token,
        name: "node-once-again",
        workspace_root: join(directory, "node-once-again"),
      }),
    ).toThrow(/already-used|Invalid/);
  });
});
