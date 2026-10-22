import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execCommand, isTransientError } from "../src/lib/exec-runner.js";

const runNode = (source: string, options = {}) =>
  execCommand({ command: process.execPath, args: ["-e", source], ...options });
describe("execCommand across platforms", () => {
  it("captures stdout, stderr and exit status", async () => {
    const result = await runNode(
      'console.log("hello world"); console.error("error"); process.exitCode=42',
    );
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.stderr.trim()).toBe("error");
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });
  it("passes prompts through stdin without shell parsing", async () => {
    const text = '한국어 "quotes" $() `backticks` --flags\n' + "long prompt ".repeat(4000);
    expect((await runNode("process.stdin.pipe(process.stdout)", { stdin: text })).stdout).toBe(
      text,
    );
  });
  it("honors cwd and environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccb-cwd-"));
    try {
      const result = await runNode(
        "console.log(JSON.stringify({cwd:process.cwd(),value:process.env.CCB_TEST_VALUE,depth:process.env.BRIDGE_DEPTH,nested:process.env.CLAUDECODE}))",
        { cwd: dir, env: { CCB_TEST_VALUE: "bridge_test", CLAUDECODE: "parent" } },
      );
      const data = JSON.parse(result.stdout);
      expect(data.cwd.toLowerCase()).toBe(dir.toLowerCase());
      expect(data.value).toBe("bridge_test");
      expect(Number(data.depth)).toBeGreaterThanOrEqual(1);
      expect(data.nested).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("times out a running process", async () => {
    expect((await runNode("setInterval(()=>{},1000)", { timeoutMs: 300 })).timedOut).toBe(true);
  });
  it("normalizes Windows-style Path overrides without losing their value", async () => {
    const result = await runNode("console.log(process.env.PATH)", {
      env: { Path: "custom-search-path" },
    });
    expect(result.stdout).toMatch(/^custom-search-path[:;]/);
  });
  it("cancels the owned child", async () => {
    const controller = new AbortController();
    const execution = runNode("setInterval(()=>{},1000)", {
      signal: controller.signal,
      timeoutMs: 5000,
    });
    setTimeout(() => controller.abort(), 300);
    expect((await execution).cancelled).toBe(true);
  });
  it("rejects a missing executable", async () => {
    await expect(
      execCommand({ command: "nonexistent_command_xyz_12345", args: [] }),
    ).rejects.toThrow("not found");
  });
  it("does not spawn an already cancelled request", async () => {
    const result = await execCommand({
      command: "must-not-be-spawned",
      args: [],
      signal: AbortSignal.abort(),
    });
    expect(result.cancelled).toBe(true);
  });
  it("does not restart a CLI when cancelled during retry backoff", async () => {
    const controller = new AbortController();
    const execution = runNode('console.error("503"); process.exitCode=1', {
      signal: controller.signal,
      maxRetries: 2,
      onStderr: () => setTimeout(() => controller.abort(), 100),
    });
    expect((await execution).cancelled).toBe(true);
  });
  it.skipIf(process.platform === "win32")(
    "kills a TERM-resistant child and its subprocess on cancellation",
    async () => {
      const controller = new AbortController();
      const dir = mkdtempSync(join(tmpdir(), "ccb-process-group-"));
      const marker = join(dir, "escaped");
      const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leak'),6500);setInterval(()=>{},1000)`;
      const source = `process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});console.log('ready');setInterval(()=>{},1000)`;
      try {
        const result = await runNode(source, {
          signal: controller.signal,
          timeoutMs: 15000,
          onStdout: () => setTimeout(() => controller.abort(), 200),
        });
        expect(result.cancelled).toBe(true);
        expect(result.timedOut).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    12000,
  );
  it("retries a transient failure once and succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccb-retry-"));
    try {
      const source =
        'const fs=require("fs"); if(fs.existsSync("counter")){console.log("success")}else{fs.writeFileSync("counter","1");console.error("503 service unavailable");process.exitCode=1}';
      expect((await runNode(source, { cwd: dir, maxRetries: 1 })).stdout.trim()).toBe("success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not retry cancelled or authentication failures", () => {
    expect(
      isTransientError({
        exitCode: 1,
        stdout: "",
        stderr: "429",
        timedOut: false,
        cancelled: true,
      }),
    ).toBe(false);
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "Invalid API key", timedOut: false }),
    ).toBe(false);
    expect(
      isTransientError({ exitCode: 1, stdout: "", stderr: "ECONNRESET", timedOut: false }),
    ).toBe(true);
  });
});
