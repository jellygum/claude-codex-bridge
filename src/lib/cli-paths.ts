import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function resolvePeerExecutable(peer: "claude" | "codex"): string {
  const override = process.env[peer === "claude" ? "CCB_CLAUDE_EXE" : "CCB_CODEX_EXE"];
  if (override) return override;
  if (process.platform !== "win32") return peer;
  const home = homedir();
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
        process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local"),
        "Programs",
        "OpenAI",
        "Codex",
        "bin",
        "codex.exe",
      ),
    );
  }
  candidates.push(...(process.env["PATH"] ?? "").split(";").map((dir) => join(dir, `${peer}.exe`)));
  return candidates.find((path) => existsSync(path)) ?? peer;
}

export function peerInvocation(peer: "claude" | "codex", args: string[]) {
  const entrypoint =
    process.env[peer === "claude" ? "CCB_CLAUDE_ENTRYPOINT" : "CCB_CODEX_ENTRYPOINT"];
  if (entrypoint) return { command: process.execPath, args: [entrypoint, ...args] };
  const command = resolvePeerExecutable(peer);
  if (command === peer && process.platform === "win32") {
    const npmRoot = join(
      process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"),
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
