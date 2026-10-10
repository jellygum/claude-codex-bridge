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
function environment(peer: "claude" | "codex" = "codex") {
  dir = mkdtempSync(join(tmpdir(), "ccb-jobs-"));
  vi.stubEnv("CCB_STATE_DIR", join(dir, "state"));
  const fake = join(dir, "peer.cjs");
  writeFileSync(
    fake,
    `if(process.argv.includes("--approve-for-me")&&process.argv.includes("--sandbox")){console.error("conflicting sandbox flags");process.exit(2)}let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{if(s==="hang")setInterval(()=>{},1000);else if(s==="fail"){console.error("mock failure");process.exitCode=1}else console.log(JSON.stringify(${peer === "claude" ? '{result:s,session_id:"test"}' : '{type:"item.completed",item:{type:"agent_message",text:s}}'}))})`,
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
    expect((await untilFinished(job.id)).status).toBe("failed");
  });
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
