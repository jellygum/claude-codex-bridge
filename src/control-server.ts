#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { cancelJob, jobInput, jobSummary, listJobs, readJob, startJob } from "./lib/jobs.js";
import { peerDiagnostics, resolvePeerExecutable } from "./lib/cli-paths.js";

const server = new McpServer(
  { name: "claude-codex-control", version: "0.3.1-dot.1" },
  {
    instructions:
      "Control user-requested Claude Code and Codex jobs on this connected computer. Always use the absolute project path. Start in read-only mode for questions and reviews; implement mode requires a requested file-changing task. Start returns a job ID immediately. Use status and result later, and cancel only the selected job. Do not recursively delegate to the bridge or run simultaneous implementations in one checkout. Dot requires separately granted local computer access; use the control CLI from a local task if local MCP tools are unavailable.",
  },
);
function response(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}
const id = { jobId: z.string().uuid() };
server.registerTool(
  "bridge_start",
  {
    title: "Start Claude or Codex job",
    description:
      "Start an independent background job on a specified local project. Returns immediately; read-only is the default.",
    inputSchema: jobInput.shape,
  },
  async (input) => response(startJob(input)),
);
server.registerTool(
  "bridge_status",
  {
    title: "Job status",
    description: "Read the status of a previously started bridge job.",
    inputSchema: id,
    annotations: { readOnlyHint: true },
  },
  async ({ jobId }) => response(jobSummary(readJob(jobId))),
);
server.registerTool(
  "bridge_result",
  {
    title: "Job result",
    description: "Read a job result or failure without restarting it.",
    inputSchema: id,
    annotations: { readOnlyHint: true },
  },
  async ({ jobId }) => {
    const job = readJob(jobId);
    return response({ ...jobSummary(job), result: job.result ?? null });
  },
);
server.registerTool(
  "bridge_cancel",
  {
    title: "Cancel job",
    description:
      "Request cancellation of only the selected job. Poll status until cancellation finishes.",
    inputSchema: id,
  },
  async ({ jobId }) => response(cancelJob(jobId)),
);
server.registerTool(
  "bridge_list",
  {
    title: "List jobs",
    description: "List recent local bridge jobs without returning their prompts or results.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    annotations: { readOnlyHint: true },
  },
  async ({ limit }) => response(listJobs(limit)),
);
server.registerTool(
  "bridge_doctor",
  {
    title: "Bridge installation",
    description:
      "Show resolved peer executables and the local access requirement; does not make model calls.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () =>
    response({
      claude: resolvePeerExecutable("claude"),
      codex: resolvePeerExecutable("codex"),
      node: process.execPath,
      peers: peerDiagnostics(),
      dot: "In your dot profile, allow access to this computer. Keep it online with ChatGPT open. Use this MCP server if exposed, otherwise the local control CLI.",
    }),
);
await server.connect(new StdioServerTransport());
console.error("claude-codex-control MCP server started on stdio");
