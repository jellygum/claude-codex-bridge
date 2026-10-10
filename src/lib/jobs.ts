import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const jobInput = z.object({
  peer: z.enum(["claude", "codex"]),
  prompt: z.string().min(1).max(100000),
  workingDirectory: z.string().min(1),
  mode: z.enum(["read-only", "implement"]).default("read-only"),
  model: z.string().min(1).optional(),
  timeoutSec: z.number().int().min(5).max(3600).default(600),
});
export type JobInput = z.infer<typeof jobInput>;
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export interface Job {
  id: string;
  request: JobInput;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  workerPid?: number;
  result?: string;
  error?: string;
}
export function stateDirectory(): string {
  return process.env["CCB_STATE_DIR"] ?? join(homedir(), ".claude-codex-bridge", "jobs");
}
export function jobPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Invalid bridge job ID");
  return join(stateDirectory(), id);
}
export function writeJob(job: Job): void {
  const dir = jobPath(job.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `job-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  renameSync(temp, join(dir, "job.json"));
}
export function readJob(id: string): Job {
  const job = JSON.parse(readFileSync(join(jobPath(id), "job.json"), "utf8")) as Job;
  if (["queued", "running"].includes(job.status)) {
    // A heartbeat distinguishes an interrupted worker from a live, long-running CLI.
    const heartbeat = join(jobPath(id), "heartbeat");
    const age =
      Date.now() -
      (existsSync(heartbeat) ? statSync(heartbeat).mtimeMs : Date.parse(job.createdAt));
    if (age > 30000)
      return {
        ...job,
        status: "failed",
        error: "Worker is unavailable. Start a new job after reconnecting the computer.",
      };
  }
  return job;
}
export function jobSummary(job: Job) {
  return {
    id: job.id,
    peer: job.request.peer,
    workingDirectory: job.request.workingDirectory,
    mode: job.request.mode,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
  };
}
export function listJobs(limit = 20) {
  if (!existsSync(stateDirectory())) return [];
  return readdirSync(stateDirectory())
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    .map((id) => {
      try {
        return readJob(id);
      } catch {
        return null;
      }
    })
    .filter((job): job is Job => job !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(jobSummary);
}
export function startJob(input: unknown) {
  if (Number(process.env["BRIDGE_DEPTH"] ?? "0") >= 2)
    throw new Error("Recursive bridge jobs are not allowed");
  const request = jobInput.parse(input);
  if (!isAbsolute(request.workingDirectory))
    throw new Error("workingDirectory must be an absolute project path");
  request.workingDirectory = realpathSync(request.workingDirectory);
  if (!statSync(request.workingDirectory).isDirectory())
    throw new Error("workingDirectory must be a directory");
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json"))) {
    const parent = dirname(root);
    if (parent === root) throw new Error("Cannot locate the bridge package");
    root = parent;
  }
  const worker = join(root, "dist", "control-worker.mjs");
  if (!existsSync(worker)) throw new Error("Build the bridge before starting a job");
  const now = new Date().toISOString();
  const job: Job = { id: randomUUID(), request, status: "queued", createdAt: now, updatedAt: now };
  writeJob(job);
  const child = spawn(process.execPath, [worker, job.id], {
    cwd: request.workingDirectory,
    env: { ...process.env, CCB_STATE_DIR: stateDirectory() },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", (err) =>
    writeJob({ ...job, status: "failed", error: err.message, updatedAt: new Date().toISOString() }),
  );
  child.unref();
  return jobSummary(job);
}
export function cancelJob(id: string) {
  const job = readJob(id);
  if (["queued", "running"].includes(job.status)) {
    // The owning worker stops its own child: never kill an arbitrary caller-supplied PID.
    writeFileSync(join(jobPath(id), "cancel"), "cancel", { mode: 0o600 });
    return { ...jobSummary(job), cancellationRequested: true };
  }
  return { ...jobSummary(job), cancellationRequested: false };
}
