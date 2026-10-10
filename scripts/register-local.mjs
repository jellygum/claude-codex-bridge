#!/usr/bin/env node
// Register this checkout without depending on npx, PATH, or a published fork package.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const home = process.env.CCB_CONFIG_HOME || homedir();
const servers = Object.fromEntries(
  ["claude", "codex", "control"].map((peer) => {
    const path = join(root, "dist", `${peer}-server.mjs`);
    if (!existsSync(path)) throw new Error("Run pnpm build before registration");
    return [`ccb-${peer}`, { command: process.execPath, args: [path] }];
  }),
);
function save(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") === content) return;
    const backup = `${path}.before-ccb-${Date.now()}.bak`;
    copyFileSync(path, backup);
    console.log(`Backup: ${backup}`);
  }
  writeFileSync(path, content, { mode: 0o600 });
  console.log(`Updated: ${path}`);
}
const codexPath = join(home, ".codex", "config.toml");
let toml = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
// Remove only these three bridge-owned sections (including their nested tables).
toml = toml.replace(
  /^\[mcp_servers\.(ccb-(?:claude|codex|control))(?:\.[^\]]+)?\]\r?\n[\s\S]*?(?=^\[|$(?![\s\S]))/gm,
  "",
);
const sections = Object.entries(servers)
  .map(
    ([name, config]) =>
      `[mcp_servers.${name}]\ncommand = ${JSON.stringify(config.command)}\nargs = ${JSON.stringify(config.args)}\ntool_timeout_sec = 600\n`,
  )
  .join("\n");
save(codexPath, `${toml.trimEnd()}\n\n${sections}`);
const claudePath = join(home, ".claude.json");
const claude = existsSync(claudePath) ? JSON.parse(readFileSync(claudePath, "utf8")) : {};
claude.mcpServers = {
  ...claude.mcpServers,
  ...Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, { type: "stdio", ...config }]),
  ),
};
save(claudePath, JSON.stringify(claude, null, 2) + "\n");

const template = readFileSync(join(root, "skills", "dot-bridge", "SKILL.md"), "utf8");
const command =
  process.platform === "win32"
    ? `& '${process.execPath.replaceAll("'", "''")}' '${join(root, "dist", "cli.mjs").replaceAll("'", "''")}'`
    : `${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "dist", "cli.mjs"))}`;
for (const folder of [".codex", ".agents", ".claude"]) {
  save(
    join(home, folder, "skills", "dot-bridge", "SKILL.md"),
    template.replaceAll("{{BRIDGE_COMMAND}}", command),
  );
}
console.log(
  "Registered ccb-claude, ccb-codex, ccb-control and dot-bridge. Reload local clients to discover new tools.",
);
