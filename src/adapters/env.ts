import { spawnSync } from "node:child_process";

const HARNESS_ENV_KEYS = [
  "QIANWEN_API_KEY",
  "DEEPSEEK_API_KEY",
  "ARK_PLAN_API_KEY",
  "ARK_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
] as const;

let cache: Record<string, string> | null = null;

function readWindowsUserEnv(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  const result = spawnSync("reg", ["query", "HKCU\\Environment", "/v", name], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return undefined;
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = line.match(/^\s*\S+\s+REG_[A-Z_]+\s+(.*)$/);
    if (match) {
      const value = match[1].trim();
      return value || undefined;
    }
  }
  return undefined;
}

/**
 * Harness CLIs sometimes read keys from process/user environment. DSH may be
 * launched before a user-level key was added, so fall back to the Windows
 * user environment without ever logging values.
 */
export function harnessEnvironment(): Record<string, string> {
  if (cache) return cache;
  const env: Record<string, string> = {};
  for (const key of HARNESS_ENV_KEYS) {
    const value = process.env[key] ?? readWindowsUserEnv(key);
    if (value) env[key] = value;
  }
  cache = env;
  return env;
}
