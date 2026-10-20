import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { CompanyService } from "./service/company-service";
import { createRealAdapters } from "./adapters";
import { runDemo, DEMO_GOAL } from "./demo";
import type {
  NodeCompletion,
  NodeEventBatch,
  NodeRegistrationRequest,
} from "./node/protocol";

export interface HttpServerOptions {
  dbPath?: string;
  port?: number;
  host?: string;
  service?: CompanyService;
}

function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing or invalid field: ${field}`);
  }
  return value;
}

function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new Error("Missing node bearer token");
  }
  return header.slice("Bearer ".length).trim();
}

export async function startHttpServer(
  options: HttpServerOptions = {},
): Promise<Server> {
  const { adapters } = createRealAdapters();
  const service =
    options.service ??
    new CompanyService({
      dbPath: options.dbPath,
      fakeDelayMs: 0,
      adapters,
    });
  const port = options.port ?? 4317;
  const host = options.host ?? "127.0.0.1";

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, service: "ai-company-runtime" });
        return;
      }
      if (method === "GET" && path === "/api/brief") {
        sendJson(res, 200, service.brief());
        return;
      }
      if (method === "GET" && path === "/api/status") {
        sendJson(res, 200, service.status());
        return;
      }
      if (method === "GET" && path === "/api/inbox") {
        sendJson(res, 200, service.inbox());
        return;
      }
      if (method === "GET" && path === "/api/threads") {
        sendJson(res, 200, service.threads());
        return;
      }
      if (method === "GET" && path === "/api/nodes") {
        sendJson(res, 200, service.nodeList());
        return;
      }
      if (method === "GET" && path === "/api/adapters") {
        sendJson(res, 200, await service.probeAdapters());
        return;
      }

      if (method === "POST" && path === "/api/node/register") {
        const body = await readJson(req);
        sendJson(
          res,
          201,
          service.registerNode(body as unknown as NodeRegistrationRequest),
        );
        return;
      }
      if (method === "POST" && path === "/api/node/heartbeat") {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          service.heartbeatNode(
            bearerToken(req),
            typeof body.capabilities === "object" && body.capabilities
              ? (body.capabilities as Record<string, unknown>)
              : undefined,
          ),
        );
        return;
      }
      if (method === "POST" && path === "/api/node/claim") {
        const body = await readJson(req);
        const leaseMs =
          typeof body.lease_ms === "number" ? body.lease_ms : undefined;
        sendJson(res, 200, service.claimTaskForNode(bearerToken(req), leaseMs));
        return;
      }
      if (method === "POST" && path === "/api/node/renew") {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          service.renewNodeLease(
            bearerToken(req),
            asString(body.run_id, "run_id"),
            asString(body.lease_token, "lease_token"),
            typeof body.lease_ms === "number" ? body.lease_ms : undefined,
          ),
        );
        return;
      }
      if (method === "POST" && path === "/api/node/events") {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          service.recordNodeEvents(
            bearerToken(req),
            body as unknown as NodeEventBatch,
          ),
        );
        return;
      }
      if (method === "POST" && path === "/api/node/complete") {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          service.completeNodeTask(
            bearerToken(req),
            body as unknown as NodeCompletion,
          ),
        );
        return;
      }
      if (method === "POST" && path === "/api/admin/enrollment-tokens") {
        const body = await readJson(req);
        sendJson(
          res,
          201,
          service.createEnrollmentToken(
            typeof body.name === "string" ? body.name : undefined,
          ),
        );
        return;
      }

      const drainMatch = path.match(/^\/api\/nodes\/([^/]+)\/(drain|revoke)$/);
      if (method === "POST" && drainMatch) {
        const identifier = decodeURIComponent(drainMatch[1]);
        const node =
          drainMatch[2] === "drain"
            ? service.setNodeDrain(identifier, true)
            : service.revokeNode(identifier);
        sendJson(res, 200, node);
        return;
      }

      if (method === "POST" && path === "/api/plan") {
        const body = await readJson(req);
        sendJson(res, 201, service.createPlan(body as never));
        return;
      }
      if (method === "POST" && path === "/api/run-ready") {
        const body = await readJson(req);
        const threadId =
          typeof body.thread_id === "string" ? body.thread_id : undefined;
        sendJson(res, 200, await service.runReady(threadId));
        return;
      }
      if (method === "POST" && path === "/api/positions") {
        const body = await readJson(req);
        sendJson(res, 201, service.hirePosition(body as never));
        return;
      }
      if (method === "POST" && path === "/api/demo") {
        const body = await readJson(req);
        const goal = typeof body.goal === "string" ? body.goal : DEMO_GOAL;
        sendJson(res, 200, await runDemo(service, goal));
        return;
      }

      const taskMatch = path.match(
        /^\/api\/tasks\/([^/]+)\/(assign|continue|reopen|cancel|wait|decision)$/,
      );
      if (method === "POST" && taskMatch) {
        const taskId = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        const body = await readJson(req);
        if (action === "assign") {
          const position =
            typeof body.position === "string" ? body.position : undefined;
          sendJson(res, 200, service.assignTask(taskId, position));
          return;
        }
        if (action === "continue") {
          sendJson(
            res,
            200,
            await service.continueTask(
              taskId,
              asString(body.instruction, "instruction"),
            ),
          );
          return;
        }
        if (action === "reopen") {
          sendJson(
            res,
            200,
            await service.reopenTask(taskId, asString(body.reason, "reason")),
          );
          return;
        }
        if (action === "cancel") {
          sendJson(res, 200, service.cancelTask(taskId));
          return;
        }
        if (action === "wait") {
          const timeout =
            typeof body.timeout_ms === "number" ? body.timeout_ms : undefined;
          sendJson(res, 200, await service.waitForTask(taskId, timeout));
          return;
        }
        if (action === "decision") {
          sendJson(res, 201, service.requestDecision({ task_id: taskId, ...body } as never));
          return;
        }
      }

      const decisionMatch = path.match(/^\/api\/decisions\/([^/]+)\/resolve$/);
      if (method === "POST" && decisionMatch) {
        const body = await readJson(req);
        sendJson(
          res,
          200,
          service.resolveDecision(
            decodeURIComponent(decisionMatch[1]),
            asString(body.chosen, "chosen"),
            typeof body.rationale === "string" ? body.rationale : null,
          ),
        );
        return;
      }

      sendJson(res, 404, { error: `Not found: ${method} ${path}` });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const sweeper = setInterval(() => {
    try {
      service.releaseExpiredLeases();
    } catch {
      // Keep the server alive; the next tick retries.
    }
  }, 5_000);
  sweeper.unref();

  server.once("close", () => {
    clearInterval(sweeper);
    service.close();
  });
  const address = server.address();
  const actualPort =
    typeof address === "object" && address ? address.port : port;
  console.error(
    `[ai-company] HTTP API listening on http://${host}:${actualPort}`,
  );
  return server;
}
