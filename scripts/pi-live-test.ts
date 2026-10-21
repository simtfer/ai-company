import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CompanyService } from "../src/service/company-service";
import { PiAdapter } from "../src/adapters/pi";

const root = join(
  process.cwd(),
  ".aic",
  "pi-live-test",
  new Date().toISOString().replaceAll(/[:.]/g, "-"),
);
const repo = join(root, "repo");
const dbPath = join(root, "company.db");
mkdirSync(repo, { recursive: true });
execFileSync("git", ["init", "-b", "main", repo], { windowsHide: true });
execFileSync("git", ["config", "user.name", "Test"], { cwd: repo, windowsHide: true });
execFileSync("git", ["config", "user.email", "test@example.com"], {
  cwd: repo,
  windowsHide: true,
});
writeFileSync(join(repo, "README.md"), "pi live test\n");
execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });

const service = new CompanyService({
  dbPath,
  approvalTimeoutMs: 120_000,
  adapters: [new PiAdapter({ kind: "pi-live", liveApproval: true })],
});
try {
  service.hirePosition({
    name: "pi-live",
    role: "engineer",
    harness_kind: "pi-live",
    workspace: repo,
  });
  const plan = service.createPlan({
    title: "pi live approval",
    goal: "verify pi tool_call permission bridge",
    tasks: [
      {
        key: "pi",
        title: "write with pi approval",
        objective:
          "Use bash to create pi.txt containing PI_OK. Then reply done.",
        acceptance: ["pi.txt exists"],
        depends_on: [],
        assignee: "pi-live",
        priority: 0,
        constraints: {
          test_command:
            "node -e \"require('fs').readFileSync('pi.txt','utf8')\"",
        },
      },
    ],
  });
  service.assignAll(plan.thread.id);
  const run = service.runReady(plan.thread.id);
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const decision of service.store.listOpenDecisions()) {
      if (seen.has(decision.id)) continue;
      seen.add(decision.id);
      console.log("APPROVING", decision.question.slice(0, 300));
      service.resolveDecision(decision.id, "允许", "pi live smoke");
    }
  }, 300);
  const results = await run;
  clearInterval(timer);
  const workspace = join(process.cwd(), ".aic", "worktrees", plan.tasks[0].id);
  const file = join(workspace, "pi.txt");
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        task: results.map((result) => ({
          status: result.report.status,
          summary: result.report.summary,
        })),
        pi_txt: existsSync(file) ? readFileSync(file, "utf8") : null,
        decisions: service.store.listOpenDecisions().length,
      },
      null,
      2,
    ),
  );
} finally {
  service.close();
}
