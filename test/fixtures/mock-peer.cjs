// Offline protocol fixture. Never starts a real CLI or makes network requests.
const fs = require("node:fs");
const args = process.argv.slice(2);
const peer = args[0] === "exec" ? "codex" : "claude";
if (args.includes("--resume") || args.includes("--continue"))
  throw Error("Must use an independent session");
if (peer === "codex" && (!args.includes("--json") || args.at(-1) !== "-"))
  throw Error("Expected JSONL and stdin");
if (peer === "claude" && !args.includes("--output-format")) throw Error("Expected JSON output");
if (args.includes("--approve-for-me") && args.includes("--sandbox"))
  throw Error("Conflicting approval flags");
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  if (process.env.CCB_TEST_TRACE)
    fs.writeFileSync(
      process.env.CCB_TEST_TRACE,
      JSON.stringify({
        args,
        cwd: process.cwd(),
        prompt,
        depth: process.env.BRIDGE_DEPTH,
        nested: process.env.CLAUDECODE,
      }),
    );
  if (prompt === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt === "auth-failure") {
    console.error("mock authentication required");
    process.exitCode = 1;
    return;
  }
  console.log(
    JSON.stringify(
      peer === "codex"
        ? { type: "item.completed", item: { type: "agent_message", text: prompt } }
        : { type: "result", subtype: "success", result: prompt, session_id: "offline-test" },
    ),
  );
});
