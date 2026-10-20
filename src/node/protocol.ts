import type { ContextPack, Position, Report, Task } from "../domain/schema";
import type { HarnessEvent, HarnessUsage } from "../adapters/types";

export interface NodeRegistrationRequest {
  token: string;
  name: string;
  os?: string;
  workspace_root: string;
  capabilities?: Record<string, unknown>;
}

export interface NodeRegistrationResponse {
  node_id: string;
  token: string;
  name: string;
  server_time: string;
}

export interface NodeHeartbeatResponse {
  drain: boolean;
  revoked: boolean;
  server_time: string;
}

export interface NodeLeaseRenewal {
  run_id: string;
  lease_token: string;
  lease_ms?: number;
}

export interface NodeLeaseResponse {
  expires_at: string;
  server_time: string;
}

export interface NodeTaskPayload {
  run_id: string;
  task: Task;
  position: Position;
  context: ContextPack;
  lease_token: string;
  expires_at: string;
}

export interface NodeClaimResponse {
  task: NodeTaskPayload | null;
}

export interface NodeEventBatch {
  run_id: string;
  lease_token: string;
  events: HarnessEvent[];
}

export interface RemoteArtifact {
  kind: string;
  filename: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface NodeCompletion {
  run_id: string;
  lease_token: string;
  report: Report;
  session_id?: string;
  usage?: HarnessUsage;
  artifacts?: RemoteArtifact[];
}

export interface NodeHeartbeatRequest {
  capabilities?: Record<string, unknown>;
}
