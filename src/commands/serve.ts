import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "serve",
    description: "Start an MCP server",
  },
  subCommands: {
    control: defineCommand({
      meta: {
        name: "control",
        description: "Start the unified job-control MCP server (for dots/local agents)",
      },
      async run() {
        await import("../control-server.js");
      },
    }),
    codex: defineCommand({
      meta: { name: "codex", description: "Start the Codex MCP server (for Claude Code)" },
      async run() {
        await import("../codex-server.js");
      },
    }),
    claude: defineCommand({
      meta: { name: "claude", description: "Start the Claude MCP server (for Codex CLI)" },
      async run() {
        await import("../claude-server.js");
      },
    }),
  },
});
