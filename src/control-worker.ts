import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execCommand } from "./lib/exec-runner.js";
import { parseClaudeOutput } from "./lib/claude-output-parser.js";
import { parseCodexOutput } from "./lib/codex-output-parser.js";
import { jobPath, readJob, writeJob } from "./lib/jobs.js";

const id = process.argv[2]!;
const job = readJob(id);
const dir = jobPath(id);
const controller = new AbortController();
const heartbeat = () => {
  writeFileSync(join(dir, "heartbeat"), "alive", { mode: 0o600 });
  if (existsSync(join(dir, "cancel"))) controller.abort();
};
heartbeat();
const timer = setInterval(heartbeat, 250);
job.status = "running";
job.workerPid = process.pid;
job.updatedAt = new Date().toISOString();
writeJob(job);
try {
  const { peer, prompt, model, mode, workingDirectory, timeoutSec } = job.request;
  const args =
    peer === "claude"
      ? ["-p", "--output-format", "json", "--max-turns", "20"]
      : ["exec", "--json", "--skip-git-repo-check"];
  if (model) args.push("--model", model);
  if (peer === "claude") {
    // --tools limits the available tools, unlike --allowedTools which only pre-approves.
    if (mode === "read-only")
      args.push("--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob");
    else args.push("--allowedTools", "Read,Grep,Glob,Edit,Write");
    args.push(
      "--permission-mode",
      "dontAsk",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
    );
  } else {
    if (mode === "implement") args.push("--approve-for-me");
    else args.push("--sandbox", "read-only");
    args.push("--", "-");
  }
  const execution = await execCommand({
    command: peer,
    args,
    stdin: prompt,
    cwd: workingDirectory,
    signal: controller.signal,
    timeoutMs: timeoutSec * 1000,
    maxRetries: 0,
  });
  const parsed =
    peer === "claude" ? parseClaudeOutput(execution.stdout) : parseCodexOutput(execution.stdout);
  job.result = "resultText" in parsed ? parsed.resultText : parsed.agentMessage;
  if (execution.cancelled || controller.signal.aborted) job.status = "cancelled";
  else if (execution.timedOut || execution.exitCode !== 0 || parsed.errors.length > 0) {
    job.status = "failed";
    job.error = execution.timedOut
      ? "CLI timed out"
      : parsed.errors.join("; ") || execution.stderr.slice(-4000) || "CLI failed";
  } else job.status = "completed";
} catch (err) {
  job.status = controller.signal.aborted ? "cancelled" : "failed";
  job.error = err instanceof Error ? err.message : String(err);
} finally {
  clearInterval(timer);
  job.updatedAt = new Date().toISOString();
  writeJob(job);
}
