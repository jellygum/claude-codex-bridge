import { defineCommand } from "citty";
import { readFileSync } from "node:fs";
import { cancelJob, jobSummary, listJobs, readJob, startJob } from "../lib/jobs.js";
import { peerDiagnostics, resolvePeerExecutable } from "../lib/cli-paths.js";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const jobArgs = {
  job: { type: "positional" as const, required: true, description: "Bridge job UUID" },
};
export default defineCommand({
  meta: {
    name: "control",
    description: "Control Claude/Codex jobs from a dot-connected local computer",
  },
  subCommands: {
    start: defineCommand({
      meta: { name: "start", description: "Start a background job and return its ID" },
      args: {
        peer: { type: "string", required: true, description: "claude or codex" },
        project: { type: "string", required: true, description: "Absolute project path" },
        prompt: { type: "string", description: "Question or task" },
        "prompt-file": { type: "string", description: "UTF-8 file containing the prompt" },
        mode: { type: "string", default: "read-only", description: "read-only or implement" },
        model: {
          type: "string",
          description: "Optional model override; default uses existing settings",
        },
        timeout: { type: "string", default: "600", description: "Timeout seconds (5–3600)" },
      },
      run({ args }) {
        if (!!args.prompt === !!args["prompt-file"])
          throw new Error("Specify exactly one of --prompt or --prompt-file");
        print(
          startJob({
            peer: args.peer,
            workingDirectory: args.project,
            prompt: args["prompt-file"] ? readFileSync(args["prompt-file"], "utf8") : args.prompt,
            mode: args.mode,
            model: args.model,
            timeoutSec: Number(args.timeout),
          }),
        );
      },
    }),
    status: defineCommand({
      args: jobArgs,
      run({ args }) {
        print(jobSummary(readJob(args.job!)));
      },
    }),
    result: defineCommand({
      args: jobArgs,
      run({ args }) {
        const job = readJob(args.job!);
        print({ ...jobSummary(job), result: job.result ?? null });
      },
    }),
    cancel: defineCommand({
      args: jobArgs,
      run({ args }) {
        print(cancelJob(args.job!));
      },
    }),
    list: defineCommand({
      run() {
        print(listJobs());
      },
    }),
    doctor: defineCommand({
      run() {
        print({
          claude: resolvePeerExecutable("claude"),
          codex: resolvePeerExecutable("codex"),
          node: process.execPath,
          peers: peerDiagnostics(),
          dot: "Requires separately granted local computer access in the dot profile.",
        });
      },
    }),
  },
});
