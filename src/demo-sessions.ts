import type { Position } from "./domain/schema";
import { ensureSampleRepo } from "./demo/sample-project";
import type { CompanyService } from "./service/company-service";

interface SessionProbe {
  kind: string;
  position: string;
  model?: string;
  first: string;
  second: string;
}

const PROBES: SessionProbe[] = [
  {
    kind: "claude-code",
    position: "claude-probe",
    first: "CLAUDE_FIRST",
    second: "CLAUDE_SECOND",
  },
  {
    kind: "pi",
    position: "pi-probe",
    model: "qianwenai/deepseek-v4.1-flash-1017",
    first: "PI_FIRST",
    second: "PI_SECOND",
  },
  {
    kind: "opencode",
    position: "opencode-probe",
    model: "deepseek/deepseek-flash",
    first: "OPENCODE_FIRST",
    second: "OPENCODE_SECOND",
  },
];

export interface SessionDemoReport {
  kind: string;
  position: string;
  first: { status: string; summary: string };
  second: { status: string; summary: string };
  session_id: string | null;
  resumed: boolean;
}

function ensurePosition(
  service: CompanyService,
  probe: SessionProbe,
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
 * Real continuation smoke test for every registered real harness.
 * This is intentionally not part of `pnpm test` because it calls models.
 */
export async function runSessionDemo(
  service: CompanyService,
): Promise<SessionDemoReport[]> {
  const repo = ensureSampleRepo();
  const registered = new Set(service.adapterKinds());
  const reports: SessionDemoReport[] = [];

  for (const probe of PROBES) {
    if (!registered.has(probe.kind)) continue;
    ensurePosition(service, probe, repo);
    const plan = service.createPlan({
      title: `${probe.kind} session 验证`,
      goal: "验证同一任务的 session 连续",
      tasks: [
        {
          key: "session",
          title: `${probe.kind} session 连续`,
          objective:
            `Reply with exactly ${probe.first} and nothing else. ` +
            "Do not read, create, edit, or delete any files.",
          acceptance: [`contains ${probe.first}`],
          depends_on: [],
          assignee: probe.position,
          priority: 0,
        },
      ],
    });
    const task = plan.tasks[0];
    service.assignTask(task.id);
    const firstResults = await service.runReady(plan.thread.id);
    const first = firstResults.find((result) => result.task.id === task.id);
    if (!first) throw new Error(`${probe.kind} produced no first result`);

    const second = await service.continueTask(
      task.id,
      `Now reply with exactly ${probe.second} and nothing else. ` +
        "Do not read, create, edit, or delete any files.",
    );
    const session = service.store.getSessionRef(first.position.id);

    reports.push({
      kind: probe.kind,
      position: probe.position,
      first: { status: first.report.status, summary: first.report.summary },
      second: { status: second.report.status, summary: second.report.summary },
      session_id: session?.session_id ?? null,
      resumed: second.report.summary.includes(probe.second),
    });
  }

  return reports;
}
