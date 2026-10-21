import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CompanyService } from "../src/service/company-service";
import { OpencodeAcpAdapter } from "../src/adapters/opencode-acp";

const root = join(
  process.cwd(),
  ".aic",
  "opencode-acp-test",
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
writeFileSync(join(repo, "README.md"), "opencode ACP test\n");
execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });

const service = new CompanyService({
  dbPath,
  approvalTimeoutMs: 120_000,
  adapters: [new OpencodeAcpAdapter()],
});
try {
  service.hirePosition({
    name: "opencode-live",
    role: "engineer",
    harness_kind: "opencode-acp",
    model: "deepseek/deepseek-flash",
    workspace: repo,
  });
  const plan = service.createPlan({
    title: "opencode ACP live approval",
    goal: "verify session/request_permission",
    tasks: [
      {
        key: "acp",
        title: "write with ACP approval",
        objective:
          "Use Bash to create acp.txt containing ACP_OK. Then reply done.",
        acceptance: ["acp.txt exists"],
        depends_on: [],
        assignee: "opencode-live",
        priority: 0,
        constraints: {
          test_command:
            "node -e \"require('fs').readFileSync('acp.txt','utf8')\"",
        },
      },
    ],
  });
  service.assignAll(plan.thread.id);
  const run = service.runReady(plan.thread.id);
  const timer = setInterval(() => {
    const decision = service.store.listOpenDecisions()[0];
    if (decision) {
      clearInterval(timer);
      console.log("APPROVING", decision.question.slice(0, 300));
      service.resolveDecision(decision.id, "允许", "ACP live smoke");
    }
  }, 300);
  const results = await run;
  clearInterval(timer);
  const workspace = join(process.cwd(), ".aic", "worktrees", plan.tasks[0].id);
  const file = join(workspace, "acp.txt");
  console.log(
    JSON.stringify(
      {
        db: dbPath,
        task: results.map((result) => ({
          status: result.report.status,
          summary: result.report.summary,
        })),
        acp_txt: existsSync(file) ? readFileSync(file, "utf8") : null,
        decisions: service.store.listOpenDecisions().length,
      },
      null,
      2,
    ),
  );
} finally {
  service.close();
}
