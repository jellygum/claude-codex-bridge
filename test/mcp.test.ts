import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));
let dir: string;
const clients: Client[] = [];
const pending = new Map<string, Client>();
async function call(client: Client, name: string, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return JSON.parse((result.content as any[]).find((item) => item.type === "text").text);
}
async function finished(client: Client, id: string) {
  for (let count = 0; count < 100; count++) {
    const result = await call(client, "bridge_result", { jobId: id });
    if (!["queued", "running"].includes(result.status)) {
      pending.delete(id);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Job did not finish");
}
afterEach(async () => {
  try {
    for (const [id, client] of pending) {
      await call(client, "bridge_cancel", { jobId: id });
      await finished(client, id);
    }
  } finally {
    pending.clear();
    await Promise.all(clients.splice(0).map((client) => client.close()));
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
async function connect(peer: string) {
  dir ||= mkdtempSync(join(tmpdir(), "ccb-mcp-"));
  // afterEach removes the previous fixture, so each test creates a fresh one.
  if (!existsSync(dir)) dir = mkdtempSync(join(tmpdir(), "ccb-mcp-"));
  const client = new Client({ name: "offline-test", version: "1.0.0" });
  clients.push(client);
  const fixture = join(root, "test", "fixtures", "mock-peer.cjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "dist", `${peer}-server.mjs`)],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      HOME: dir,
      USERPROFILE: dir,
      CODEX_HOME: join(dir, ".codex"),
      CLAUDE_CONFIG_DIR: join(dir, ".claude"),
      CCB_STATE_DIR: join(dir, "state"),
      CCB_CLAUDE_ENTRYPOINT: fixture,
      CCB_CODEX_ENTRYPOINT: fixture,
      CCB_TEST_TRACE: join(dir, "trace.json"),
      BRIDGE_DEPTH: "0",
      BRIDGE_MAX_RETRIES: "0",
      CLAUDECODE: "parent",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  await client.connect(transport);
  return client;
}
it.each(["claude", "codex", "control"])(
  "initializes %s over stdio and lists all six tools without authentication",
  async (peer) => {
    const client = await connect(peer);
    const result = await client.listTools();
    expect(result.tools).toHaveLength(6);
    expect(
      result.tools.every((tool) =>
        tool.name.startsWith(peer === "control" ? "bridge_" : `${peer}_`),
      ),
    ).toBe(true);
  },
);
it.each(["claude", "codex"])("calls the %s query tool using only a mock CLI", async (peer) => {
  const client = await connect(peer);
  const prompt = '한국어 "quotes" $() `literal`\nsecond line';
  const result = await client.callTool({
    name: `${peer}_query`,
    arguments: { prompt, workingDirectory: dir },
  });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{ type: "text", text: prompt }]);
  expect(JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"))).toMatchObject({
    prompt,
    cwd: dir,
    depth: "1",
  });
});
it.each(["claude", "codex"])("starts, polls and retrieves a %s job through MCP", async (peer) => {
  const client = await connect("control");
  const job = await call(client, "bridge_start", {
    peer,
    prompt: "offline result",
    workingDirectory: dir,
  });
  pending.set(job.id, client);
  expect(await call(client, "bridge_status", { jobId: job.id })).toHaveProperty("status");
  expect(await finished(client, job.id)).toMatchObject({
    status: "completed",
    result: "offline result",
  });
  const trace = JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"));
  expect(trace).toMatchObject({ cwd: dir, depth: "1" });
  expect(trace.nested).toBeUndefined();
  if (peer === "claude")
    expect(trace.args).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--tools",
        "Read,Grep,Glob",
      ]),
    );
  else expect(trace.args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
  expect(await call(client, "bridge_list")).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: job.id, status: "completed" })]),
  );
});
it("cancels one running job through MCP and returns authentication failures separately", async () => {
  const client = await connect("control");
  const job = await call(client, "bridge_start", {
    peer: "codex",
    prompt: "hang",
    workingDirectory: dir,
  });
  pending.set(job.id, client);
  for (let count = 0; count < 100 && !existsSync(join(dir, "trace.json")); count++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  expect(existsSync(join(dir, "trace.json"))).toBe(true);
  expect(await call(client, "bridge_cancel", { jobId: job.id })).toHaveProperty(
    "cancellationRequested",
    true,
  );
  expect(await finished(client, job.id)).toHaveProperty("status", "cancelled");
  const failure = await call(client, "bridge_start", {
    peer: "claude",
    prompt: "auth-failure",
    workingDirectory: dir,
  });
  pending.set(failure.id, client);
  expect(await finished(client, failure.id)).toMatchObject({
    status: "failed",
    error: expect.stringContaining("mock authentication required"),
  });
});
it("returns MCP errors for invalid paths and unknown jobs without corrupting the session", async () => {
  const client = await connect("control");
  for (const request of [
    {
      name: "bridge_start",
      arguments: { peer: "codex", prompt: "test", workingDirectory: "relative" },
    },
    { name: "bridge_result", arguments: { jobId: "00000000-0000-4000-8000-000000000000" } },
  ]) {
    expect((await client.callTool(request)).isError).toBe(true);
  }
  expect(await call(client, "bridge_list")).toEqual([]);
});
