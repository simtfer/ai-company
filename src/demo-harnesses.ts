import type { Position } from "./domain/schema";
import { ensureSampleRepo } from "./demo/sample-project";
import type { CompanyService, ExecutionResult, PlanResult } from "./service/company-service";
import { discoverHarnesses } from "./adapters";

interface HarnessProbe {
  kind: string;
  position: string;
  token: string;
  model?: string;
}

const PROBES: HarnessProbe[] = [
  {
    kind: "claude-code",
    position: "claude-probe",
    token: "CLAUDE_OK",
  },
  {
    kind: "pi",
    position: "pi-probe",
    token: "PI_OK",
    model: "qianwenai/deepseek-v4.1-flash-1017",
  },
  {
    kind: "opencode",
    position: "opencode-probe",
    token: "OPENCODE_OK",
    model: "deepseek/deepseek-flash",
  },
];

export interface HarnessDemoResult {
  plan: PlanResult;
  discovered: ReturnType<typeof discoverHarnesses>;
  executions: ExecutionResult[];
  skipped: string[];
  status: Record<string, unknown>;
}

function ensurePosition(
  service: CompanyService,
  probe: HarnessProbe,
  repo: string,
): Position {
  const existing = service.store.getPositionByName(probe.position);
  if (existing) return existing;
  return service.hirePosition({
    name: probe.position,
    role: "probe",
    harness_kind: probe.kind,
    workspace: repo,
    ...(probe.model ? { model: probe.model } : {}),
  });
}

/**
 * Verify every discovered harness with a tiny, side-effect-free prompt.
 * This is deliberately not part of `pnpm test` because it calls real models.
 */
export async function runHarnessDemo(
  service: CompanyService,
): Promise<HarnessDemoResult> {
  const repo = ensureSampleRepo();
  const discovered = discoverHarnesses();
  const registered = new Set(service.adapterKinds());
  const skipped: string[] = [];
  const probes = PROBES.filter((probe) => {
    if (!registered.has(probe.kind)) {
      skipped.push(probe.kind);
      return false;
    }
    return true;
  });

  const plan = service.createPlan({
    title: "M1 harness 验证",
    goal: "用最小副作用验证 Claude Code、pi、opencode 适配器",
    tasks: probes.map((probe, index) => ({
      key: probe.kind,
      title: `${probe.kind} 连通性验证`,
      objective:
        `Reply with exactly ${probe.token} and nothing else. ` +
        "Do not read, create, edit, or delete any files.",
      acceptance: [`response contains ${probe.token}`],
      depends_on: [],
      assignee: probe.position,
      priority: 0,
      constraints: {
        write_scope: [],
      },
    })),
  });

  for (const probe of probes) {
    ensurePosition(service, probe, repo);
  }
  service.assignAll(plan.thread.id);
  const executions = await service.runReady(plan.thread.id);

  return {
    plan,
    discovered,
    executions,
    skipped,
    status: service.status(),
  };
}
