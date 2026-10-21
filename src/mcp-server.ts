import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CompanyService } from "./service/company-service";
import { createRealAdapters } from "./adapters";
import { runDemo, DEMO_GOAL } from "./demo";

type JsonResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): JsonResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function fail(error: unknown): JsonResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

async function guarded(fn: () => unknown | Promise<unknown>): Promise<JsonResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

export function buildMcpServer(service: CompanyService): McpServer {
  const server = new McpServer({
    name: "ai-company",
    version: "0.1.0",
  });

  server.registerTool(
    "company_brief",
    {
      description:
        "Read the company handbook, org chart, positions, recent threads and open decision count.",
      inputSchema: {},
    },
    async () => guarded(() => service.brief()),
  );

  server.registerTool(
    "company_status",
    {
      description:
        "Show who is doing what: positions, current tasks, task status counts and open decisions.",
      inputSchema: {},
    },
    async () => guarded(() => service.status()),
  );

  server.registerTool(
    "company_inbox",
    {
      description:
        "Read recent task reports, blocked/failed tasks and open decisions since the last CEO turn.",
      inputSchema: {
        limit: z.number().int().positive().max(100).optional(),
      },
    },
    async (args) => guarded(() => service.inbox(args.limit ?? 20)),
  );

  server.registerTool(
    "company_threads",
    {
      description: "List goal threads with task counts and status.",
      inputSchema: {},
    },
    async () => guarded(() => service.threads()),
  );

  server.registerTool(
    "company_plan_create",
    {
      description:
        "Create a task DAG for a goal. Every task must have acceptance criteria and a unique key; depends_on references other keys.",
      inputSchema: {
        title: z.string().min(1),
        goal: z.string().min(1),
        thread_id: z.string().optional(),
        tasks: z
          .array(
            z.object({
              key: z.string().min(1),
              title: z.string().min(1),
              objective: z.string().min(1),
              acceptance: z.array(z.string().min(1)).min(1),
              depends_on: z.array(z.string()).optional(),
              assignee: z.string().optional(),
              priority: z.number().int().optional(),
              constraints: z.any().optional(),
              budget: z
                .object({
                  minutes: z.number().positive().optional(),
                  usd: z.number().nonnegative().optional(),
                })
                .optional(),
              deadline: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    async (args) =>
      guarded(() =>
        service.createPlan({
          ...args,
          tasks: args.tasks.map((task) => ({
            ...task,
            depends_on: task.depends_on ?? [],
            priority: task.priority ?? 0,
          })),
        }),
      ),
  );

  server.registerTool(
    "company_task_assign",
    {
      description:
        "Assign a task to a position. If position is omitted, use the assignee already recorded on the task.",
      inputSchema: {
        task_id: z.string().min(1),
        position: z.string().optional(),
      },
    },
    async (args) => guarded(() => service.assignTask(args.task_id, args.position)),
  );

  server.registerTool(
    "company_task_assign_all",
    {
      description: "Assign every queued task that already has an assignee.",
      inputSchema: {
        thread_id: z.string().optional(),
      },
    },
    async (args) => guarded(() => service.assignAll(args.thread_id)),
  );

  server.registerTool(
    "company_run_ready",
    {
      description:
        "Run all assigned tasks whose dependencies are done. Returns execution reports.",
      inputSchema: {
        thread_id: z.string().optional(),
      },
    },
    async (args) => guarded(() => service.runReady(args.thread_id)),
  );

  server.registerTool(
    "company_task_continue",
    {
      description:
        "Continue the same task with an additional instruction. The runtime resumes the session if valid, otherwise rebuilds from the context pack.",
      inputSchema: {
        task_id: z.string().min(1),
        instruction: z.string().min(1),
      },
    },
    async (args) =>
      guarded(() => service.continueTask(args.task_id, args.instruction)),
  );

  server.registerTool(
    "company_task_reopen",
    {
      description: "Reopen a done, blocked or failed task with a reason.",
      inputSchema: {
        task_id: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async (args) => guarded(() => service.reopenTask(args.task_id, args.reason)),
  );

  server.registerTool(
    "company_task_cancel",
    {
      description: "Cancel a task and free its position.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args) => guarded(() => service.cancelTask(args.task_id)),
  );

  server.registerTool(
    "company_task_wait",
    {
      description:
        "Wait for a task to reach a terminal or waiting_approval state. Use a short timeout; do not block a CEO turn for hours.",
      inputSchema: {
        task_id: z.string().min(1),
        timeout_ms: z.number().int().positive().max(120_000).optional(),
      },
    },
    async (args) =>
      guarded(() => service.waitForTask(args.task_id, args.timeout_ms ?? 30_000)),
  );

  server.registerTool(
    "company_decision_request",
    {
      description:
        "Ask the human for a decision and attach it to a task. The CEO should render options and a recommendation in chat.",
      inputSchema: {
        task_id: z.string().min(1),
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(1),
      },
    },
    async (args) => guarded(() => service.requestDecision(args)),
  );

  server.registerTool(
    "company_decision_resolve",
    {
      description: "Record the human's chosen option for an open decision.",
      inputSchema: {
        decision_id: z.string().min(1),
        chosen: z.string().min(1),
        rationale: z.string().optional(),
      },
    },
    async (args) =>
      guarded(() =>
        service.resolveDecision(
          args.decision_id,
          args.chosen,
          args.rationale ?? null,
        ),
      ),
  );

  server.registerTool(
    "company_position_hire",
    {
      description:
        "Hire a position on the local node. In M0 the harness kind is fake; M1 replaces it with real adapters.",
      inputSchema: {
        name: z.string().min(1),
        role: z.string().min(1),
        harness_kind: z.string().optional(),
        model: z.string().optional(),
        workspace: z.string().optional(),
        node_id: z.string().optional(),
      },
    },
    async (args) =>
      guarded(() =>
        service.hirePosition({
          ...args,
          harness_kind: args.harness_kind ?? "fake",
        }),
      ),
  );

  server.registerTool(
    "company_position_pause",
    {
      description: "Pause a position so it will not accept new tasks.",
      inputSchema: { name: z.string().min(1) },
    },
    async (args) => guarded(() => service.pausePosition(args.name)),
  );

  server.registerTool(
    "company_position_fire",
    {
      description: "Fire a position. Its tasks remain in the task board.",
      inputSchema: { name: z.string().min(1) },
    },
    async (args) => guarded(() => service.firePosition(args.name)),
  );

  server.registerTool(
    "company_node_list",
    {
      description: "List nodes/offices and the positions on each.",
      inputSchema: {},
    },
    async () => guarded(() => service.nodeList()),
  );

  server.registerTool(
    "company_budget_status",
    {
      description:
        "Show company and position budget spend/remaining, plus task costs.",
      inputSchema: {},
    },
    async () => guarded(() => service.budgetStatus()),
  );

  server.registerTool(
    "company_set_company_budget",
    {
      description: "Set the company USD budget (and optional minutes).",
      inputSchema: {
        usd: z.number().nonnegative(),
        minutes: z.number().positive().optional(),
      },
    },
    async (args) =>
      guarded(() => service.setCompanyBudget(args.usd, args.minutes)),
  );

  server.registerTool(
    "company_set_position_budget",
    {
      description: "Set a position's USD budget.",
      inputSchema: {
        name: z.string().min(1),
        usd: z.number().nonnegative(),
      },
    },
    async (args) =>
      guarded(() => service.setPositionBudget(args.name, args.usd)),
  );

  server.registerTool(
    "company_metrics",
    {
      description:
        "Show task/run metrics, token and USD spend, retries, nodes and merge queue counts.",
      inputSchema: {},
    },
    async () => guarded(() => service.metrics()),
  );

  server.registerTool(
    "company_memory_search",
    {
      description:
        "Search company handbook, position memory and thread summaries.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async (args) =>
      guarded(() => service.searchMemory(args.query, args.limit ?? 20)),
  );

  server.registerTool(
    "company_task_retry",
    {
      description: "Manually retry a failed or blocked task.",
      inputSchema: { task_id: z.string().min(1) },
    },
    async (args) => guarded(() => service.retryTask(args.task_id)),
  );

  server.registerTool(
    "company_review_request",
    {
      description:
        "Create an independent review task for a done task and add it to the merge queue.",
      inputSchema: {
        task_id: z.string().min(1),
        reviewer: z.string().min(1),
      },
    },
    async (args) =>
      guarded(() => service.requestReview(args.task_id, args.reviewer)),
  );

  server.registerTool(
    "company_merge_queue",
    {
      description: "List merge queue entries, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["pending_review", "ready", "merged", "rejected"])
          .optional(),
      },
    },
    async (args) => guarded(() => service.mergeQueue(args.status)),
  );

  server.registerTool(
    "company_merge_approve",
    {
      description: "Approve a ready merge queue entry.",
      inputSchema: { entry_id: z.string().min(1) },
    },
    async (args) => guarded(() => service.approveMerge(args.entry_id)),
  );

  server.registerTool(
    "company_merge_reject",
    {
      description: "Reject a merge queue entry with a reason.",
      inputSchema: {
        entry_id: z.string().min(1),
        reason: z.string().min(1),
      },
    },
    async (args) =>
      guarded(() => service.rejectMerge(args.entry_id, args.reason)),
  );

  server.registerTool(
    "company_adapters",
    {
      description:
        "Probe registered harness adapters and report version and resume/streaming capability.",
      inputSchema: {},
    },
    async () => guarded(() => service.probeAdapters()),
  );

  server.registerTool(
    "company_node_enroll",
    {
      description:
        "Create a one-time enrollment token for a new computer. Give the token to `aic node join` on that computer.",
      inputSchema: {
        name: z.string().optional(),
      },
    },
    async (args) => guarded(() => service.createEnrollmentToken(args.name)),
  );

  server.registerTool(
    "company_node_drain",
    {
      description:
        "Stop a node from accepting new tasks while leaving existing state intact.",
      inputSchema: { node: z.string().min(1) },
    },
    async (args) => guarded(() => service.setNodeDrain(args.node, true)),
  );

  server.registerTool(
    "company_node_revoke",
    {
      description:
        "Revoke a node token and stop it from claiming tasks. Its positions remain for reassignment.",
      inputSchema: { node: z.string().min(1) },
    },
    async (args) => guarded(() => service.revokeNode(args.node)),
  );

  server.registerTool(
    "company_demo",
    {
      description:
        "Run the M0 end-to-end demo: plan, assign fake positions, execute, and return reports.",
      inputSchema: {
        goal: z.string().optional(),
      },
    },
    async (args) => guarded(() => runDemo(service, args.goal ?? DEMO_GOAL)),
  );

  return server;
}

export async function startMcpServer(dbPath?: string): Promise<void> {
  const { adapters } = createRealAdapters();
  const service = new CompanyService({
    dbPath,
    fakeDelayMs: 0,
    adapters,
  });
  const server = buildMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ai-company] MCP server ready (stdio)");

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } finally {
      service.close();
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
