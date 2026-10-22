import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolvePeerExecutable(
  peer: "claude" | "codex",
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env[peer === "claude" ? "CCB_CLAUDE_EXE" : "CCB_CODEX_EXE"];
  if (override) return override;
  const home = env["HOME"] || homedir();
  if (process.platform !== "win32") {
    // Non-login SSH/MCP processes do not necessarily source shell startup files.
    // Honor PATH first, then common per-user/native and active Node installations.
    const prefix = env["npm_config_prefix"] || env["NPM_CONFIG_PREFIX"];
    const directories = [
      ...(env["PATH"] ?? "").split(":"),
      join(home, ".local", "bin"),
      join(home, "bin"),
      ...(prefix ? [join(prefix, "bin")] : []),
      dirname(process.execPath),
    ];
    return (
      directories
        .filter((dir) => isAbsolute(dir))
        .map((dir) => join(dir, peer))
        .find(isExecutable) ?? peer
    );
  }
  const candidates = [join(home, ".local", "bin", `${peer}.exe`)];
  if (peer === "claude") {
    const extensions = join(home, ".vscode", "extensions");
    if (existsSync(extensions)) {
      candidates.push(
        ...readdirSync(extensions)
          .filter((name) => /^anthropic\.claude-code-\d.*-win32-(x64|arm64)$/.test(name))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
          .map((name) => join(extensions, name, "resources", "native-binary", "claude.exe")),
      );
    }
  } else {
    candidates.push(
      join(
        env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"),
        "Programs",
        "OpenAI",
        "Codex",
        "bin",
        "codex.exe",
      ),
    );
  }
  candidates.push(
    ...(env["PATH"] ?? env["Path"] ?? "")
      .split(";")
      .filter(Boolean)
      .map((dir) => join(dir, `${peer}.exe`)),
  );
  return candidates.find((path) => existsSync(path)) ?? peer;
}

export function peerInvocation(
  peer: "claude" | "codex",
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const entrypoint = env[peer === "claude" ? "CCB_CLAUDE_ENTRYPOINT" : "CCB_CODEX_ENTRYPOINT"];
  if (entrypoint) return { command: process.execPath, args: [entrypoint, ...args] };
  const command = resolvePeerExecutable(peer, env);
  if (command === peer && process.platform === "win32") {
    const npmRoot = join(
      env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
      "npm",
      "node_modules",
    );
    const script =
      peer === "claude"
        ? join(npmRoot, "@anthropic-ai", "claude-code", "cli.js")
        : join(npmRoot, "@openai", "codex", "bin", "codex.js");
    if (existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  }
  return { command, args };
}

export function peerDiagnostics() {
  return Object.fromEntries(
    (["claude", "codex"] as const).map((peer) => {
      const invocation = peerInvocation(peer, []);
      return [
        peer,
        {
          ...invocation,
          available:
            isAbsolute(invocation.command) &&
            isExecutable(invocation.command) &&
            (invocation.args.length === 0 || existsSync(invocation.args[0]!)),
        },
      ];
    }),
  );
}
