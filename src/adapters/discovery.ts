import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function which(name: string): string | null {
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
      : spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const first = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ?? null;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((path) => existsSync(path)) ?? null;
}

function versionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function nvmInstallRoots(): string[] {
  const roots = [
    process.env.NVM_INSTALLS,
    process.env.NVM_HOME ? join(process.env.NVM_HOME, "installs") : undefined,
    join(homedir(), "AppData", "Local", "nvm", "installs"),
    join(homedir(), "AppData", "Roaming", "nvm", "installs"),
    "D:\\Programs\\nvm\\installs",
  ].filter((root): root is string => Boolean(root));
  return roots;
}

function claudeCandidates(): string[] {
  const candidates = [
    process.env.AIC_CLAUDE_COMMAND,
    process.env.CLAUDE_CODE_PATH,
    which("claude"),
    join(homedir(), ".local", "bin", "claude"),
    join(homedir(), ".local", "bin", "claude.exe"),
    join(homedir(), ".claude", "local", "claude"),
  ].filter((path): path is string => Boolean(path));

  for (const root of nvmInstallRoots()) {
    for (const version of versionDirs(root)) {
      candidates.push(
        join(version, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        join(version, "claude.exe"),
        join(version, "claude.cmd"),
      );
    }
  }
  return candidates;
}

function piCandidates(): string[] {
  const candidates = [
    process.env.AIC_PI_COMMAND,
    which("pi"),
    join(homedir(), ".local", "bin", "pi"),
    join(homedir(), ".local", "bin", "pi.exe"),
  ].filter((path): path is string => Boolean(path));

  const workbuddyRoot = join(
    homedir(),
    ".workbuddy",
    "binaries",
    "node",
    "versions",
  );
  for (const version of versionDirs(workbuddyRoot)) {
    candidates.push(join(version, "pi.exe"), join(version, "pi.cmd"));
  }
  return candidates;
}

export interface CommandSpec {
  command: string;
  argsPrefix: string[];
}

export function findPiSpec(): CommandSpec | null {
  const env = process.env.AIC_PI_COMMAND;
  if (env) {
    return env.endsWith(".js") || env.endsWith(".mjs")
      ? { command: process.execPath, argsPrefix: [env] }
      : { command: env, argsPrefix: [] };
  }
  const workbuddyRoot = join(
    homedir(),
    ".workbuddy",
    "binaries",
    "node",
    "versions",
  );
  for (const version of versionDirs(workbuddyRoot)) {
    const cli = join(
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    if (existsSync(cli)) {
      const node = join(version, "node.exe");
      return {
        command: existsSync(node) ? node : process.execPath,
        argsPrefix: [cli],
      };
    }
    const exe = join(version, "pi.exe");
    if (existsSync(exe)) return { command: exe, argsPrefix: [] };
  }
  const command = findPiCommand();
  return command ? { command, argsPrefix: [] } : null;
}

function opencodeCandidates(): string[] {
  return [
    process.env.AIC_OPENCODE_COMMAND,
    which("opencode"),
    join(homedir(), "scoop", "shims", "opencode.exe"),
    join(homedir(), ".local", "bin", "opencode"),
  ].filter((path): path is string => Boolean(path));
}

export function findClaudeCommand(): string | null {
  return firstExisting(claudeCandidates());
}

export function findPiCommand(): string | null {
  return firstExisting(piCandidates());
}

export function findOpencodeCommand(): string | null {
  return firstExisting(opencodeCandidates());
}

export interface DiscoveredHarnesses {
  claude: string | null;
  pi: string | null;
  opencode: string | null;
}

export function discoverHarnesses(): DiscoveredHarnesses {
  return {
    claude: findClaudeCommand(),
    pi: findPiCommand(),
    opencode: findOpencodeCommand(),
  };
}
