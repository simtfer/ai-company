import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitWorkspaceManager } from "../src/workspace/git-workspace";
import type { Task } from "../src/domain/schema";

let directory: string;
let repo: string;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ai-company-workspace-"));
  repo = join(directory, "repo");
  execFileSync("git", ["init", "-b", "main", repo], {
    encoding: "utf8",
    windowsHide: true,
  });
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "hello.mjs"), 'export const hello = "hello";\n');
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("GitWorkspaceManager", () => {
  it("creates an isolated worktree, commits changes and captures a diff", () => {
    const manager = new GitWorkspaceManager(join(directory, "worktrees"));
    const workspace = manager.prepare(repo, "t_workspace");
    expect(workspace.is_git).toBe(true);
    expect(workspace.cwd).not.toBe(repo);
    expect(existsSync(join(workspace.cwd, "hello.mjs"))).toBe(true);

    writeFileSync(
      join(workspace.cwd, "hello.mjs"),
      'export const hello = "hello";\nexport const greet = (name) => `Hello, ${name}!`;\n',
    );
    const task = {
      id: "t_workspace",
      title: "add greet",
    } as Task;
    const result = manager.finalize(workspace, task, "r_workspace");

    expect(result.changed_files).toContain("hello.mjs");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].branch).toBe(workspace.branch);
    expect(result.changes[0].commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(result.diff_path).toBeTruthy();
    expect(result.diff).toContain("greet");
    expect(git(workspace.cwd, ["log", "-1", "--pretty=%s"])).toContain(
      "add greet",
    );
  });

  it("pushes a task branch to a shared remote", () => {
    const bare = join(directory, "remote.git");
    execFileSync("git", ["init", "--bare", bare], {
      encoding: "utf8",
      windowsHide: true,
    });
    git(repo, ["remote", "add", "origin", bare]);

    const manager = new GitWorkspaceManager(join(directory, "worktrees"));
    const workspace = manager.prepare(repo, "t_push");
    writeFileSync(join(workspace.cwd, "pushed.txt"), "shared\n");
    const task = { id: "t_push", title: "push" } as Task;
    const finalized = manager.finalize(workspace, task, "r_push");
    const pushed = manager.push(workspace);

    expect(pushed.ok).toBe(true);
    expect(pushed.ref).toBe(`origin/${workspace.branch}`);
    expect(
      git(bare, ["rev-parse", `refs/heads/${workspace.branch}`]),
    ).toBe(finalized.changes[0].commit);
  });
});
