import { spawn, type ChildProcess } from "node:child_process";

export interface JsonlProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (value: unknown, raw: string) => void;
  onStderr?: (chunk: string) => void;
  maxStderrBytes?: number;
}

export interface JsonlProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  lines: unknown[];
  stderr: string;
  timedOut: boolean;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // already gone
  }
}

export async function runJsonlProcess(
  command: string,
  args: string[],
  options: JsonlProcessOptions,
): Promise<JsonlProcessResult> {
  const lines: unknown[] = [];
  let stderr = "";
  let stdoutBuffer = "";
  let timedOut = false;
  const maxStderr = options.maxStderrBytes ?? 200_000;

  return await new Promise<JsonlProcessResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        lines,
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
      if (stdoutBuffer.trim()) {
        const raw = stdoutBuffer.trim();
        try {
          const parsed = JSON.parse(raw) as unknown;
          lines.push(parsed);
          options.onLine?.(parsed, raw);
        } catch {
          // keep malformed trailing output in stderr for diagnostics
          stderr += `\n[non-json stdout] ${raw.slice(0, 2000)}`;
        }
      }
      resolve({ code, signal, lines, stderr, timedOut });
    };

    const onAbort = (): void => {
      killTree(child);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        killTree(child);
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, options.timeoutMs)
        : null;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const raw = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as unknown;
            lines.push(parsed);
            options.onLine?.(parsed, raw);
          } catch {
            options.onStderr?.(`[non-json] ${raw.slice(0, 2000)}\n`);
            stderr += `[non-json] ${raw.slice(0, 2000)}\n`;
          }
        }
        newline = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = String(chunk);
      options.onStderr?.(text);
      if (stderr.length < maxStderr) {
        stderr += text.slice(0, maxStderr - stderr.length);
      }
    });

    child.once("error", (error) => {
      stderr += `\n${error.message}`;
      finish(null, null);
    });
    child.once("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
