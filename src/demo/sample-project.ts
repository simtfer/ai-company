import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

/**
 * A disposable real git repository for the M1 end-to-end demo.
 * It lives under .aic/ and is intentionally ignored by the company repo.
 */
export function ensureSampleRepo(): string {
  const repo = join(process.cwd(), ".aic", "demo-project");
  if (existsSync(join(repo, ".git"))) {
    return repo;
  }

  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    `${JSON.stringify(
      {
        name: "aic-demo-project",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeFileSync(
    join(repo, "hello.mjs"),
    'export function hello() {\n  return "hello";\n}\n',
    "utf8",
  );
  writeFileSync(
    join(repo, "hello.test.mjs"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { hello } from "./hello.mjs";',
      "",
      'test("hello returns hello", () => {',
      '  assert.equal(hello(), "hello");',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(repo, "README.md"),
    "# AIC demo project\n\nA disposable repository used by the AI Company M1 demo.\n",
    "utf8",
  );

  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "AI Company Demo"]);
  git(repo, ["config", "user.email", "demo@ai-company.local"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "chore: initialize demo project"]);
  return repo;
}
