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
  expect(toml).toContain('CCB_OLD = "old"');
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

it.each(["{invalid", "[]", '{"mcpServers": []}'])(
  "does not write Codex settings if Claude JSON is invalid: %s",
  async (invalid) => {
    configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
    mkdirSync(join(configHome, ".codex"));
    const original = 'model = "keep"\n';
    writeFileSync(join(configHome, ".codex", "config.toml"), original);
    writeFileSync(join(configHome, ".claude.json"), invalid);
    const result = await execCommand({
      command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url))],
      env: { CCB_CONFIG_HOME: configHome },
      maxRetries: 0,
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(configHome, ".codex", "config.toml"), "utf8")).toBe(original);
    expect(readdirSync(join(configHome, ".codex"))).toEqual(["config.toml"]);
  },
);

it("dry-run validates without creating configuration or skills", async () => {
  configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
  const result = await execCommand({
    command: process.execPath,
    args: [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url)), "--dry-run"],
    env: { CCB_CONFIG_HOME: configHome },
    maxRetries: 0,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Would update");
  expect(readdirSync(configHome)).toEqual([]);
});

it("preserves bridge-specific Claude environment and rejects unknown options", async () => {
  configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
  const original = {
    mcpServers: { "ccb-claude": { command: "old", env: { CCB_CLAUDE_EXE: "/custom/claude" } } },
  };
  writeFileSync(join(configHome, ".claude.json"), JSON.stringify(original));
  const args = [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url))];
  const env = { CCB_CONFIG_HOME: configHome };
  expect(
    (await execCommand({ command: process.execPath, args: [...args, "--dryrun"], env })).exitCode,
  ).not.toBe(0);
  expect(readdirSync(configHome)).toEqual([".claude.json"]);
  expect((await execCommand({ command: process.execPath, args, env })).exitCode).toBe(0);
  expect(
    JSON.parse(readFileSync(join(configHome, ".claude.json"), "utf8")).mcpServers["ccb-claude"].env,
  ).toEqual(original.mcpServers["ccb-claude"].env);
});

it.skipIf(process.platform === "win32")(
  "preserves configuration symlinks and keeps backups private",
  async () => {
    const { symlinkSync, lstatSync, statSync } = await import("node:fs");
    configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
    mkdirSync(join(configHome, ".codex"));
    const target = join(configHome, "managed.toml");
    writeFileSync(target, 'model="preserved"\n', { mode: 0o644 });
    const link = join(configHome, ".codex", "config.toml");
    symlinkSync(target, link);
    const result = await execCommand({
      command: process.execPath,
      args: [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url))],
      env: { CCB_CONFIG_HOME: configHome },
    });
    expect(result.exitCode).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("ccb-claude");
    const backup = readdirSync(configHome).find((name) => name.endsWith(".bak"))!;
    expect(statSync(join(configHome, backup)).mode & 0o777).toBe(0o600);
  },
);

it("honors custom config locations and keeps CCB_CONFIG_HOME isolated", async () => {
  configHome = mkdtempSync(join(tmpdir(), "ccb-config-"));
  const customCodex = join(configHome, "custom-codex");
  const customClaude = join(configHome, "custom-claude");
  const args = [fileURLToPath(new URL("../scripts/register-local.mjs", import.meta.url))];
  const result = await execCommand({
    command: process.execPath,
    args,
    env: {
      HOME: configHome,
      USERPROFILE: configHome,
      CCB_CONFIG_HOME: "",
      CODEX_HOME: customCodex,
      CLAUDE_CONFIG_DIR: customClaude,
      CCB_CLAUDE_CONFIG_FILE: join(customClaude, "user-mcp.json"),
    },
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(customCodex, "config.toml"), "utf8")).toContain("ccb-control");
  expect(
    JSON.parse(readFileSync(join(customClaude, "user-mcp.json"), "utf8")).mcpServers["ccb-control"],
  ).toHaveProperty("type", "stdio");
  const dry = await execCommand({
    command: process.execPath,
    args: [...args, "--dry-run"],
    env: { CCB_CONFIG_HOME: configHome, CODEX_HOME: customCodex, CLAUDE_CONFIG_DIR: customClaude },
  });
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain(join(configHome, ".codex", "config.toml"));
});
