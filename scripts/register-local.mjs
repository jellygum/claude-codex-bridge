#!/usr/bin/env node
// Register this checkout without depending on npx or a published fork package.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote, updateCodexConfig } from "./lib/register-config.mjs";

if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
  throw new Error("Usage: node scripts/register-local.mjs [--dry-run]");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isolated = process.env.CCB_CONFIG_HOME;
const home = resolve(isolated || homedir());
const codexDir = isolated
  ? join(home, ".codex")
  : resolve(process.env.CODEX_HOME || join(home, ".codex"));
const claudeDir = isolated
  ? join(home, ".claude")
  : resolve(process.env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
if (!isolated && process.env.CLAUDE_CONFIG_DIR && !process.env.CCB_CLAUDE_CONFIG_FILE) {
  throw new Error(
    "Custom CLAUDE_CONFIG_DIR: set CCB_CLAUDE_CONFIG_FILE to the CLI's user MCP JSON file before registration.",
  );
}
const codexPath = join(codexDir, "config.toml");
const claudePath =
  !isolated && process.env.CCB_CLAUDE_CONFIG_FILE
    ? resolve(process.env.CCB_CLAUDE_CONFIG_FILE)
    : join(home, ".claude.json");
const servers = Object.fromEntries(
  ["claude", "codex", "control"].map((peer) => {
    const path = join(root, "dist", `${peer}-server.mjs`);
    if (!existsSync(path)) throw new Error("Run pnpm build before registration");
    return [`ccb-${peer}`, { command: process.execPath, args: [path] }];
  }),
);
for (const name of ["cli", "control-worker"]) {
  if (!existsSync(join(root, "dist", `${name}.mjs`)))
    throw new Error("Run pnpm build before registration");
}
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const originalToml = read(codexPath);
const originalClaude = read(claudePath);
const toml = updateCodexConfig(originalToml, servers);
const claude = originalClaude ? JSON.parse(originalClaude) : {};
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
if (!isObject(claude) || (claude.mcpServers !== undefined && !isObject(claude.mcpServers))) {
  throw new Error("Claude config and mcpServers must be JSON objects; no files were changed.");
}
claude.mcpServers ??= {};
for (const [name, config] of Object.entries(servers)) {
  const previous = claude.mcpServers[name];
  if (previous !== undefined && (!isObject(previous) || previous.url !== undefined)) {
    throw new Error(
      `Invalid or remote ${name} configuration; rename it before local registration.`,
    );
  }
  claude.mcpServers[name] = { ...previous, type: "stdio", ...config };
}
const template = readFileSync(join(root, "skills", "dot-bridge", "SKILL.md"), "utf8");
const command =
  process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' '${join(root, "dist", "cli.mjs").replaceAll("'", "''")}'`
    : `${shellQuote(process.execPath)} ${shellQuote(join(root, "dist", "cli.mjs"))}`;
const updates = [
  [codexPath, toml],
  [claudePath, JSON.stringify(claude, null, 2) + "\n"],
  ...[codexDir, join(home, ".agents"), claudeDir].map((folder) => [
    join(folder, "skills", "dot-bridge", "SKILL.md"),
    template.replaceAll("{{BRIDGE_COMMAND}}", command),
  ]),
];
// Read every destination before touching either client. Dry-run never writes files.
const plan = updates.map(([path, content]) => ({
  // Preserve existing config symlinks (common with dotfile managers).
  path: existsSync(path) ? realpathSync(path) : path,
  content,
  original: read(path),
}));
for (const { path, content, original } of plan) {
  if (original === content) continue;
  if (process.argv.includes("--dry-run")) {
    console.log(`Would update: ${path}`);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (read(path) !== original)
    throw new Error(`Configuration changed during registration: ${path}. Close clients and retry.`);
  if (existsSync(path)) {
    const backup = `${path}.before-ccb-${Date.now()}-${randomUUID()}.bak`;
    writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
    console.log(`Backup: ${backup}`);
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  console.log(`Updated: ${path}`);
}
console.log(
  process.argv.includes("--dry-run")
    ? "Dry run complete; no files changed."
    : "Registered ccb-claude, ccb-codex, ccb-control and dot-bridge. Reload local clients to discover new tools.",
);
