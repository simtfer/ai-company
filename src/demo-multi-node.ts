import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CompanyService } from "./service/company-service";
import { FakeHarness } from "./adapters/fake";
import { startHttpServer } from "./http-server";
import { NodeAgent } from "./node/agent";

export interface MultiNodeDemoResult {
  reports: Array<{
    title: string;
    assignee: string | null;
    status: string;
    summary: string;
  }>;
  nodes: Array<Record<string, unknown>>;
}

/**
 * Start two real HTTP node agents on this machine (separate workspace roots),
 * dispatch two tasks, and verify remote artifact return.
 */
export async function runMultiNodeDemo(): Promise<MultiNodeDemoResult> {
  const root = join(process.cwd(), ".aic", "m2-demo");
  const nodeARoot = join(root, "node-a");
  const nodeBRoot = join(root, "node-b");
  mkdirSync(nodeARoot, { recursive: true });
  mkdirSync(nodeBRoot, { recursive: true });

  const service = new CompanyService({
    dbPath: join(root, "company.db"),
    fakeDelayMs: 0,
    adapters: [new FakeHarness(0)],
    remoteWaitMs: 10_000,
  });
  const server = await startHttpServer({ service, port: 0 });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const agents: NodeAgent[] = [];
  const suffix = randomUUID().slice(0, 6);
  try {
    for (const [baseName, workspace] of [
      ["node-a", nodeARoot],
      ["node-b", nodeBRoot],
    ] as const) {
      const name = `${baseName}-${suffix}`;
      const { token } = service.createEnrollmentToken(name);
      const agent = new NodeAgent({
        serverUrl: baseUrl,
        enrollmentToken: token,
        name,
        workspaceRoot: workspace,
        adapters: [new FakeHarness(0)],
        pollMs: 200,
        heartbeatMs: 1_000,
        leaseMs: 30_000,
      });
      await agent.start();
      agents.push(agent);
      service.hirePosition({
        name: `${name}-worker`,
        role: "worker",
        harness_kind: "fake",
        node_id: agent.nodeId!,
        workspace: join("workspace", `${name}-worker`),
      });
    }

    const plan = service.createPlan({
      title: "M2 多节点演示",
      goal: "两台电脑各执行一个远程任务，并回传测试产物",
      tasks: [
        {
          key: "a",
          title: "节点 A 的任务",
          objective: "在节点 A 执行任务",
          acceptance: ["done"],
          depends_on: [],
          assignee: `node-a-${suffix}-worker`,
          priority: 1,
          constraints: { test_command: 'node -e "console.log(\'node-a-ok\')"' },
        },
        {
          key: "b",
          title: "节点 B 的任务",
          objective: "在节点 B 执行任务",
          acceptance: ["done"],
          depends_on: [],
          assignee: `node-b-${suffix}-worker`,
          priority: 0,
          constraints: { test_command: 'node -e "console.log(\'node-b-ok\')"' },
        },
      ],
    });
    service.assignAll(plan.thread.id);
    const executions = await service.runReady(plan.thread.id);

    return {
      reports: executions.map((execution) => ({
        title: execution.task.title,
        assignee: execution.task.assignee,
        status: execution.report.status,
        summary: execution.report.summary,
      })),
      nodes: service.nodeList(),
    };
  } finally {
    for (const agent of agents) {
      await agent.stop();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
