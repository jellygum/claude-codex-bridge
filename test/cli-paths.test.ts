import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { peerInvocation, resolvePeerExecutable } from "../src/lib/cli-paths.js";
import { execCommand } from "../src/lib/exec-runner.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("POSIX executable discovery", () => {
  function fixture() {
    dir = mkdtempSync(join(tmpdir(), "ccb paths ' $-"));
    const bin = join(dir, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    return { bin, env: { HOME: dir, PATH: "/nonexistent" } };
  }
  it("finds executable native installations when SSH PATH is minimal", () => {
    const { bin, env } = fixture();
    const exe = join(bin, "claude");
    symlinkSync(process.execPath, exe);
    expect(resolvePeerExecutable("claude", env)).toBe(exe);
  });
  it("runs npm-style env-node launchers with a minimal non-login PATH", async () => {
    const { bin, env } = fixture();
    writeFileSync(join(bin, "codex"), '#!/usr/bin/env node\nconsole.log("npm launcher works")\n', {
      mode: 0o700,
    });
    const result = await execCommand({ command: "codex", args: [], env, maxRetries: 0 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("npm launcher works");
  });
  it("prefers PATH and skips non-executable files and directories", () => {
    const { bin, env } = fixture();
    const first = join(dir, "first");
    mkdirSync(first);
    mkdirSync(join(first, "claude"));
    writeFileSync(join(first, "codex"), "not executable", { mode: 0o600 });
    for (const peer of ["claude", "codex"] as const) {
      symlinkSync(process.execPath, join(bin, peer));
      expect(resolvePeerExecutable(peer, { ...env, PATH: `${first}:${bin}` })).toBe(
        join(bin, peer),
      );
    }
    chmodSync(join(first, "codex"), 0o700);
    expect(resolvePeerExecutable("codex", { ...env, PATH: `${first}:${bin}` })).toBe(
      join(first, "codex"),
    );
  });
  it("honors npm prefix and explicit executable/entrypoint overrides", async () => {
    const { env } = fixture();
    const prefix = join(dir, "npm prefix");
    mkdirSync(join(prefix, "bin"), { recursive: true });
    symlinkSync(process.execPath, join(prefix, "bin", "codex"));
    expect(resolvePeerExecutable("codex", { ...env, npm_config_prefix: prefix })).toBe(
      join(prefix, "bin", "codex"),
    );
    expect(
      peerInvocation("codex", ["--version"], { CCB_CODEX_ENTRYPOINT: "/tmp/mock.cjs" }),
    ).toEqual({ command: process.execPath, args: ["/tmp/mock.cjs", "--version"] });
    const result = await execCommand({
      command: "codex",
      args: ["-e", 'console.log("override works")'],
      env: { CCB_CODEX_EXE: process.execPath },
      maxRetries: 0,
    });
    expect(result.stdout.trim()).toBe("override works");
  });
});
