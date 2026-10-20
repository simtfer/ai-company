import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { Task } from "../domain/schema";

export interface PreparedWorkspace {
  cwd: string;
  repo: string;
  branch: string;
  base_ref: string;
  is_git: boolean;
}

export interface WorkspaceChanges {
  repo: string;
  branch: string;
  commit: string;
  files: string[];
}

export interface WorkspaceResult {
  changes: WorkspaceChanges[];
  changed_files: string[];
  diff_path: string | null;
  diff: string;
}

function runGit(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

export class GitWorkspaceManager {
  constructor(private readonly worktreeRoot = join(process.cwd(), ".aic", "worktrees")) {}

  prepare(
    baseRepo: string,
    taskId: string,
    baseRef?: string,
  ): PreparedWorkspace {
    const repoPath = resolve(baseRepo);
    mkdirSync(repoPath, { recursive: true });
    const top = runGit(repoPath, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || resolve(top.stdout.trim()) !== repoPath) {
      return {
        cwd: repoPath,
        repo: repoPath,
        branch: "",
        base_ref: "",
        is_git: false,
      };
    }
    const repo = top.stdout.trim();
    const branch = `task/${sanitize(taskId)}`;
    const cwd = join(this.worktreeRoot, sanitize(taskId));
    mkdirSync(this.worktreeRoot, { recursive: true });

    const existing = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    if (existing.ok) {
      return {
        cwd,
        repo,
        branch,
        base_ref: baseRef ?? this.resolveRef(repo, "HEAD"),
        is_git: true,
      };
    }

    const ref = baseRef ?? "HEAD";
    const branchExists = runGit(repo, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ]).ok;
    const add = branchExists
      ? runGit(repo, ["worktree", "add", cwd, branch])
      : runGit(repo, ["worktree", "add", "-b", branch, cwd, ref]);
    if (!add.ok) {
      // A stale directory may exist without a registered worktree.
      const force = branchExists
        ? runGit(repo, ["worktree", "add", "--force", cwd, branch])
        : runGit(repo, ["worktree", "add", "--force", "-b", branch, cwd, ref]);
      if (!force.ok) {
        throw new Error(
          `Failed to prepare worktree ${cwd}: ${force.stderr || add.stderr}`,
        );
      }
    }

    return {
      cwd,
      repo,
      branch,
      base_ref: this.resolveRef(repo, ref),
      is_git: true,
    };
  }

  finalize(
    workspace: PreparedWorkspace,
    task: Task,
    runId: string,
  ): WorkspaceResult {
    if (!workspace.is_git) {
      return {
        changes: [],
        changed_files: [],
        diff_path: null,
        diff: "",
      };
    }

    const status = runGit(workspace.cwd, ["status", "--porcelain"]);
    if (status.ok && status.stdout.trim()) {
      runGit(workspace.cwd, ["add", "-A"]);
      runGit(workspace.cwd, [
        "commit",
        "-m",
        `task: ${task.title}\n\nTask-Id: ${task.id}\nRun-Id: ${runId}`,
      ]);
    }

    const head = runGit(workspace.cwd, ["rev-parse", "HEAD"]);
    const commit = head.ok ? head.stdout.trim() : "";
    const diff = runGit(workspace.cwd, [
      "diff",
      `${workspace.base_ref}..HEAD`,
    ]);
    const files = runGit(workspace.cwd, [
      "diff",
      "--name-only",
      `${workspace.base_ref}..HEAD`,
    ]);
    const changedFiles = files.ok
      ? files.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    const diffText = diff.ok ? diff.stdout : "";
    let diffPath: string | null = null;
    if (diffText) {
      const artifactDir = join(process.cwd(), ".aic", "artifacts");
      mkdirSync(artifactDir, { recursive: true });
      diffPath = join(artifactDir, `${runId}.diff`);
      writeFileSync(diffPath, diffText, "utf8");
    }

    return {
      changes:
        commit && changedFiles.length > 0
          ? [
              {
                repo: workspace.repo,
                branch: workspace.branch,
                commit,
                files: changedFiles,
              },
            ]
          : [],
      changed_files: changedFiles,
      diff_path: diffPath,
      diff: diffText,
    };
  }

  private resolveRef(repo: string, ref: string): string {
    const result = runGit(repo, ["rev-parse", ref]);
    return result.ok ? result.stdout.trim() : ref;
  }
}
