import { join } from "node:path";
import type { HarnessAdapter } from "../adapters/types";
import { GitWorkspaceManager } from "../workspace/git-workspace";
import { RemoteTaskExecutor } from "./executor";
import type {
  NodeClaimResponse,
  NodeCompletion,
  NodeEventBatch,
  NodeHeartbeatResponse,
  NodeRegistrationResponse,
  NodeTaskPayload,
} from "./protocol";

export interface NodeAgentOptions {
  serverUrl: string;
  name: string;
  workspaceRoot: string;
  enrollmentToken?: string;
  nodeToken?: string;
  adapters: HarnessAdapter[];
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class NodeAgent {
  readonly name: string;
  readonly workspaceRoot: string;
  private readonly serverUrl: string;
  private readonly enrollmentToken?: string;
  private readonly adapters: HarnessAdapter[];
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly executor: RemoteTaskExecutor;
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private lastHeartbeat = 0;

  nodeId: string | null = null;
  nodeToken: string | null = null;
  lastError: string | null = null;

  constructor(options: NodeAgentOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");
    this.name = options.name;
    this.workspaceRoot = options.workspaceRoot;
    this.enrollmentToken = options.enrollmentToken;
    this.nodeToken = options.nodeToken ?? null;
    this.adapters = options.adapters;
    this.pollMs = options.pollMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? 2_000;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.executor = new RemoteTaskExecutor(
      options.adapters,
      new GitWorkspaceManager(join(options.workspaceRoot, ".worktrees")),
    );
  }

  async register(): Promise<NodeRegistrationResponse> {
    if (!this.enrollmentToken) {
      throw new Error("NodeAgent requires an enrollment token to register");
    }
    const response = await fetch(`${this.serverUrl}/api/node/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: this.enrollmentToken,
        name: this.name,
        os: process.platform,
        workspace_root: this.workspaceRoot,
        capabilities: {
          harnesses: this.adapters.map((adapter) => adapter.kind),
          max_concurrency: 1,
        },
      }),
    });
    const body = (await response.json()) as NodeRegistrationResponse & {
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `Node registration failed (${response.status})`);
    }
    this.nodeId = body.node_id;
    this.nodeToken = body.token;
    return body;
  }

  async start(): Promise<void> {
    if (!this.nodeToken) {
      await this.register();
    }
    if (this.loopPromise) return;
    this.stopped = false;
    this.loopPromise = this.loop().finally(() => {
      this.loopPromise = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        if (Date.now() - this.lastHeartbeat >= this.heartbeatMs) {
          const heartbeat = await this.heartbeat();
          this.lastHeartbeat = Date.now();
          if (heartbeat.revoked) {
            this.lastError = "node revoked";
            this.stopped = true;
            break;
          }
          if (heartbeat.drain) {
            await sleep(this.pollMs);
            continue;
          }
        }
        const task = await this.claim();
        if (task) {
          await this.executeClaim(task);
        } else {
          await sleep(this.pollMs);
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await sleep(Math.max(this.pollMs, 1_000));
      }
    }
  }

  private async heartbeat(): Promise<NodeHeartbeatResponse> {
    return this.request<NodeHeartbeatResponse>("/api/node/heartbeat", {
      capabilities: {
        harnesses: this.adapters.map((adapter) => adapter.kind),
        max_concurrency: 1,
      },
    });
  }

  private async claim(): Promise<NodeTaskPayload | null> {
    const response = await this.request<NodeClaimResponse>("/api/node/claim", {
      lease_ms: this.leaseMs,
    });
    return response.task;
  }

  private async executeClaim(payload: NodeTaskPayload): Promise<void> {
    const renewEvery = Math.max(1_000, Math.floor(this.leaseMs / 2));
    const renewTimer = setInterval(() => {
      void this.renewLease(payload).catch((error: unknown) => {
        this.lastError =
          error instanceof Error ? error.message : String(error);
      });
    }, renewEvery);
    renewTimer.unref();

    try {
      const result = await this.executor.execute({
        run_id: payload.run_id,
        task: payload.task,
        position: payload.position,
        context: payload.context,
        workspace_root: this.workspaceRoot,
      });

      if (result.events.length > 0) {
        await this.request("/api/node/events", {
          run_id: payload.run_id,
          lease_token: payload.lease_token,
          events: result.events,
        } satisfies NodeEventBatch);
      }

      const completion: NodeCompletion = {
        run_id: payload.run_id,
        lease_token: payload.lease_token,
        report: result.report,
        session_id: result.session_id,
        usage: result.usage,
        artifacts: result.artifacts,
      };
      await this.request("/api/node/complete", completion);
    } finally {
      clearInterval(renewTimer);
    }
  }

  private async renewLease(payload: NodeTaskPayload): Promise<void> {
    await this.request("/api/node/renew", {
      run_id: payload.run_id,
      lease_token: payload.lease_token,
      lease_ms: this.leaseMs,
    });
  }

  private async request<T>(
    path: string,
    body: unknown,
  ): Promise<T> {
    if (!this.nodeToken) throw new Error("Node is not registered");
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.nodeToken}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? `Node request failed (${response.status})`);
    }
    return payload;
  }
}
