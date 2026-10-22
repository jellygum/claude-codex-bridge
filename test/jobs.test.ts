import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelJob, jobPath, listJobs, readJob, startJob } from "../src/lib/jobs.js";

let dir: string;
afterEach(async () => {
  // A final result is written before the worker exits. Await process exit before
  // deleting its Windows cwd; synchronous deletion can race that final teardown.
  for (const summary of listJobs()) {
    const pid = readJob(summary.id).workerPid;
    if (!pid) continue;
    for (let count = 0; count < 100; count++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
function environment(peer: "claude" | "codex" = "codex", stdout?: string) {
  dir = mkdtempSync(join(tmpdir(), "ccb-jobs-"));
  vi.stubEnv("CCB_STATE_DIR", join(dir, "state"));
  const fake = join(dir, "peer.cjs");
  writeFileSync(
    fake,
    `if(process.argv.includes("--approve-for-me")&&process.argv.includes("--sandbox")){console.error("conflicting sandbox flags");process.exit(2)}let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{if(s==="hang")setInterval(()=>{},1000);else if(s==="fail"){console.error("mock failure");process.exitCode=1}else ${stdout !== undefined ? `process.stdout.write(${JSON.stringify(stdout)})` : `console.log(JSON.stringify(${peer === "claude" ? '{result:s,session_id:"test"}' : '{type:"item.completed",item:{type:"agent_message",text:s}}'}))`}})`,
  );
  vi.stubEnv(peer === "claude" ? "CCB_CLAUDE_ENTRYPOINT" : "CCB_CODEX_ENTRYPOINT", fake);
}
async function untilFinished(id: string) {
  for (let count = 0; count < 80; count++) {
    const job = readJob(id);
    if (!["queued", "running"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Worker did not finish");
}
describe("persistent job control", () => {
  it("uses automatic workspace approval without incompatible sandbox flags", async () => {
    environment();
    const job = startJob({
      peer: "codex",
      prompt: "implement task",
      workingDirectory: dir,
      mode: "implement",
    });
    expect((await untilFinished(job.id)).status).toBe("completed");
  });
  it("rejects invalid IDs and project paths before creating a job", () => {
    environment();
    expect(() => jobPath("../../secret")).toThrow("Invalid");
    expect(() =>
      startJob({ peer: "claude", prompt: "hello", workingDirectory: "relative" }),
    ).toThrow("absolute");
  });
  it.each(["claude", "codex"] as const)(
    "runs a mock %s CLI and persists the result",
    async (peer) => {
      environment(peer);
      const summary = startJob({ peer, prompt: "mock connection", workingDirectory: dir });
      const job = await untilFinished(summary.id);
      expect(job.status).toBe("completed");
      expect(job.result).toBe("mock connection");
      expect(listJobs()[0]?.id).toBe(summary.id);
      expect(listJobs()[0]).not.toHaveProperty("result");
      expect(readFileSync(join(jobPath(summary.id), "job.json"), "utf8")).toContain("completed");
    },
  );
  it("reports a failing CLI as failed", async () => {
    environment();
    const job = startJob({ peer: "codex", prompt: "fail", workingDirectory: dir });
    const failed = await untilFinished(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("mock failure");
  });
  it.each([
    { peer: "codex", stdout: "", error: "Empty output from Codex CLI" },
    {
      peer: "codex",
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "qa" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 0 } }),
      ].join("\n"),
      error: "No agent answer in Codex CLI output",
    },
    {
      peer: "codex",
      stdout: JSON.stringify({
        type: "turn.failed",
        error: { message: "QA_CODEX_ERROR" },
      }),
      error: "QA_CODEX_ERROR",
    },
    {
      peer: "claude",
      stdout: JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["QA_MAX_TURNS"],
        result: "",
      }),
      error: "QA_MAX_TURNS",
    },
    {
      peer: "claude",
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        result: "",
      }),
      error: "No agent answer in Claude CLI output",
    },
  ] as const)("persists zero-exit $peer failures ($error)", async ({ peer, stdout, error }) => {
    environment(peer, stdout);
    const summary = startJob({ peer, prompt: "parser regression", workingDirectory: dir });
    const job = await untilFinished(summary.id);
    expect(job.status).toBe("failed");
    expect(job.result).toBe("");
    expect(job.error).toBe(error);
    const persisted = JSON.parse(readFileSync(join(jobPath(summary.id), "job.json"), "utf8"));
    expect(persisted).toMatchObject({ status: "failed", result: "", error });
    expect(listJobs()[0]).toMatchObject({ status: "failed", error });
  });
  it.each(["claude", "codex"] as const)(
    "preserves legacy plain-text %s job answers",
    async (peer) => {
      environment(peer, "Legacy answer");
      const summary = startJob({ peer, prompt: "parser regression", workingDirectory: dir });
      expect(await untilFinished(summary.id)).toMatchObject({
        status: "completed",
        result: "Legacy answer",
      });
    },
  );
  it.each(["claude", "codex"] as const)(
    "preserves structured %s answers containing JSON protocol-like text",
    async (peer) => {
      const answer = '{"type":"error","message":"This is answer text"}';
      environment(
        peer,
        JSON.stringify(
          peer === "claude"
            ? {
                type: "result",
                subtype: "success",
                is_error: false,
                errors: [],
                result: answer,
              }
            : { type: "item.completed", item: { type: "agent_message", text: answer } },
        ),
      );
      const summary = startJob({ peer, prompt: "parser regression", workingDirectory: dir });
      expect(await untilFinished(summary.id)).toMatchObject({
        status: "completed",
        result: answer,
      });
    },
  );
  it("cancels only the selected running job", async () => {
    environment();
    const selected = startJob({ peer: "codex", prompt: "hang", workingDirectory: dir });
    const other = startJob({ peer: "codex", prompt: "other answer", workingDirectory: dir });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(cancelJob(selected.id).cancellationRequested).toBe(true);
    expect((await untilFinished(selected.id)).status).toBe("cancelled");
    expect((await untilFinished(other.id)).status).toBe("completed");
  });
});

it("keeps a relative state directory stable when the worker changes cwd", async () => {
  environment();
  const { relative } = await import("node:path");
  vi.stubEnv("CCB_STATE_DIR", relative(process.cwd(), join(dir, "state")));
  const summary = startJob({ peer: "codex", prompt: "relative state", workingDirectory: dir });
  expect(await untilFinished(summary.id)).toMatchObject({
    status: "completed",
    result: "relative state",
  });
});
