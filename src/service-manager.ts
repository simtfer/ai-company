import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface ServiceInstallOptions {
  name?: string;
  nodePath?: string;
  entryPath?: string;
  port?: number;
  host?: string;
  dbPath?: string;
  apply?: boolean;
}

export interface ServiceDefinition {
  platform: "windows" | "linux";
  name: string;
  command: string;
  configPath: string;
  content: string;
  applyCommand: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '`"')}"`;
}

export function buildServiceDefinition(
  options: ServiceInstallOptions = {},
): ServiceDefinition {
  const name = options.name ?? "AI Company Runtime";
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 4317;
  const nodePath = options.nodePath ?? process.execPath;
  const entryPath = options.entryPath ?? join(process.cwd(), "bin", "aic.mjs");
  const dbPath = options.dbPath;
  const serveArgs = [
    quote(entryPath),
    "serve",
    "--host",
    host,
    "--port",
    String(port),
  ].join(" ");

  if (process.platform === "win32") {
    const script = [
      `$action = New-ScheduledTaskAction -Execute ${quote(nodePath)} -Argument '${serveArgs}'`,
      "$trigger = New-ScheduledTaskTrigger -AtStartup",
      '$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest',
      `Register-ScheduledTask -TaskName ${quote(name)} -Action $action -Trigger $trigger -Principal $principal -Force`,
      ...(dbPath
        ? [
            `[Environment]::SetEnvironmentVariable("AIC_DB_PATH", ${quote(dbPath)}, "Machine")`,
          ]
        : []),
    ].join("\r\n");
    return {
      platform: "windows",
      name,
      command: `${nodePath} ${serveArgs}`,
      configPath: `Task Scheduler\\${name}`,
      content: script,
      applyCommand: "powershell -NoProfile -ExecutionPolicy Bypass -File <script>",
    };
  }

  const content = `[Unit]
Description=${name}
After=network.target

[Service]
Type=simple
WorkingDirectory=${process.cwd()}
ExecStart=${nodePath} ${serveArgs}
Restart=always
RestartSec=3
${dbPath ? `Environment=AIC_DB_PATH=${dbPath}` : ""}

[Install]
WantedBy=multi-user.target
`;
  return {
    platform: "linux",
    name,
    command: `${nodePath} ${serveArgs}`,
    configPath: `/etc/systemd/system/${name.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}.service`,
    content,
    applyCommand: "sudo systemctl daemon-reload && sudo systemctl enable --now <unit>",
  };
}

export function installService(options: ServiceInstallOptions = {}): {
  definition: ServiceDefinition;
  applied: boolean;
  output: string;
} {
  const definition = buildServiceDefinition(options);
  if (!existsSync(options.entryPath ?? join(process.cwd(), "bin", "aic.mjs"))) {
    throw new Error("Service entry not found; run `pnpm build` or use --entry");
  }
  if (!options.apply) {
    return { definition, applied: false, output: definition.content };
  }

  if (definition.platform === "windows") {
    const dir = mkdtempSync(join(tmpdir(), "aic-service-"));
    const script = join(dir, "install-task.ps1");
    writeFileSync(script, definition.content, "utf8");
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`Service install failed: ${result.stderr || result.stdout}`);
    }
    return { definition, applied: true, output: result.stdout };
  }

  const result = spawnSync(
    "sudo",
    ["tee", definition.configPath],
    { input: definition.content, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Service install failed: ${result.stderr || result.stdout}`);
  }
  const unit = definition.configPath;
  const enable = spawnSync("sudo", ["systemctl", "enable", "--now", unit], {
    encoding: "utf8",
  });
  if (enable.status !== 0) {
    throw new Error(`systemctl failed: ${enable.stderr || enable.stdout}`);
  }
  return { definition, applied: true, output: enable.stdout };
}

export function uninstallService(name = "AI Company Runtime", apply = false): string {
  if (process.platform === "win32") {
    const command = `Unregister-ScheduledTask -TaskName ${quote(name)} -Confirm:$false`;
    if (!apply) return command;
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", command],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout;
  }
  const unit = `${name.replaceAll(/[^a-zA-Z0-9_.-]/g, "-")}.service`;
  const command = `sudo systemctl disable --now ${unit} && sudo rm /etc/systemd/system/${unit}`;
  if (!apply) return command;
  const result = spawnSync("bash", ["-lc", command], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
