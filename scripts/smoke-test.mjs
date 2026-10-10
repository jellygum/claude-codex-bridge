#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const live = process.argv.includes("--live");
const implement = process.argv.includes("--implement");
const clients = [];
const results = [];
try {
  for (const peer of ["claude", "codex", "control"]) {
    const client = new Client({ name: "ccb-smoke", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", `${peer}-server.mjs`)],
      env: { ...process.env, CCB_STATE_DIR: join(root, ".bridge-state", "smoke") },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
    clients.push(client);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6, `${peer} tool count`);
    results.push({ peer, handshake: "PASS", tools: tools.tools.map((t) => t.name) });
  }
  if (live || implement) {
    const client = clients[2];
    async function call(name, args) {
      const response = await client.callTool({ name, arguments: args });
      assert(!response.isError, JSON.stringify(response.content));
      return JSON.parse(response.content.find((c) => c.type === "text").text);
    }
    for (const peer of ["claude", "codex"]) {
      const sentinel = `DOT_BRIDGE_${peer.toUpperCase()}_OK`;
      let project = root;
      if (implement) {
        const state = join(root, ".bridge-state", "implement");
        mkdirSync(state, { recursive: true });
        project = mkdtempSync(join(state, `${peer}-`));
      }
      const job = await call("bridge_start", {
        peer,
        prompt: implement
          ? `Create BRIDGE_TEST.txt in the working directory with exactly ${sentinel}. This single file write is authorized. Do not modify other files or call bridge tools. Reply with ${sentinel}.`
          : `Reply with exactly ${sentinel}. Do not use tools or modify any files.`,
        workingDirectory: project,
        mode: implement ? "implement" : "read-only",
        timeoutSec: 180,
      });
      const deadline = Date.now() + 190000;
      let status;
      do {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = await call("bridge_status", { jobId: job.id });
      } while (["queued", "running"].includes(status.status) && Date.now() < deadline);
      const result = await call("bridge_result", { jobId: job.id });
      assert.equal(result.status, "completed", result.error);
      assert(result.result.includes(sentinel), "Live response must contain sentinel");
      if (implement)
        assert.equal(readFileSync(join(project, "BRIDGE_TEST.txt"), "utf8").trim(), sentinel);
      results.push({
        peer,
        liveJob: "PASS",
        mode: implement ? "implement" : "read-only",
        jobId: job.id,
        result: result.result,
      });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  console.log(JSON.stringify({ success: true, results }, null, 2));
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
