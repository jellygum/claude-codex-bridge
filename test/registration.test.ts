import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execCommand } from "../src/lib/exec-runner.js";

let configHome: string;
afterEach(() => {
  if (configHome) rmSync(configHome, { recursive: true, force: true, maxRetries: 5 });
});
it("registers this build while preserving unrelated settings, backups and idempotence", async () => {
  configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
  mkdirSync(join(configHome, ".codex"));
  const originalToml =
    'model = "user-model"\r\n[mcp_servers.other]\r\ncommand = "keep-me"\r\n[mcp_servers.ccb-claude]\r\ncommand = "old"\r\nargs = ["old"]\r\n[mcp_servers.ccb-claude.env]\r\nCCB_OLD = "old"\r\n[projects."project"]\r\ntrust_level = "trusted"\r\n';
  const originalClaude = {
    model: "user-model",
    custom: { preserved: true },
    mcpServers: { other: { command: "keep-me" } },
  };
  writeFileSync(join(configHome, ".codex", "config.toml"), originalToml);
  writeFileSync(join(configHome, ".claude.json"), JSON.stringify(originalClaude));
  const run = () =>
    execCommand({
      command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url))],
      env: { CCB_CONFIG_HOME: configHome },
      maxRetries: 0,
    });
  expect((await run()).exitCode).toBe(0);
  const toml = readFileSync(join(configHome, ".codex", "config.toml"), "utf8");
  expect(toml).toContain('model = "user-model"');
  expect(toml).toContain('[mcp_servers.other]\r\ncommand = "keep-me"');
  expect(toml).toContain('[projects."project"]\r\ntrust_level = "trusted"');
  expect(toml).not.toContain("CCB_OLD");
  for (const peer of ["claude", "codex", "control"])
    expect(toml.split(`[mcp_servers.ccb-${peer}]`).length).toBe(2);
  const claude = JSON.parse(readFileSync(join(configHome, ".claude.json"), "utf8"));
  expect(claude.model).toBe(originalClaude.model);
  expect(claude.custom).toEqual(originalClaude.custom);
  expect(claude.mcpServers.other).toEqual(originalClaude.mcpServers.other);
  const backup = readdirSync(join(configHome, ".codex")).find((name) => name.includes(".bak"))!;
  expect(readFileSync(join(configHome, ".codex", backup), "utf8")).toBe(originalToml);
  const skill = readFileSync(
    join(configHome, ".codex", "skills", "dot-bridge", "SKILL.md"),
    "utf8",
  );
  expect(skill).not.toContain("{{BRIDGE_COMMAND}}");
  expect(skill).toContain(process.execPath);
  expect((await run()).exitCode).toBe(0);
  expect(readFileSync(join(configHome, ".codex", "config.toml"), "utf8")).toBe(toml);
  expect(
    readdirSync(join(configHome, ".codex")).filter((name) => name.includes(".bak")),
  ).toHaveLength(1);
});
