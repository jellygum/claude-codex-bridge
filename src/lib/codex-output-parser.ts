import { logger } from "./logger.js";
import type { CodexResult } from "./types.js";

// Max characters to store per command output to prevent memory bloat.
const MAX_COMMAND_OUTPUT = 10_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n...[truncated]";
}

/**
 * Parses the JSONL output from `codex exec --json`.
 * Each line is a JSON event with a `type` field.
 *
 * Real Codex CLI uses a **nested** format where item data lives inside
 * an `item` object:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *
 * We also support a legacy flat format for backward compatibility:
 *   {"type":"item.completed","itemType":"agent_message","text":"..."}
 */
export function parseCodexOutput(jsonlOutput: string): CodexResult {
  const result: CodexResult = {
    threadId: null,
    agentMessage: "",
    fileChanges: [],
    commandsExecuted: [],
    usage: null,
    errors: [],
  };

  const lines = jsonlOutput.split("\n").filter((l) => l.trim().length > 0);
  let hasProtocolEvents = false;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.debug(`Skipping non-JSON line: ${line.slice(0, 100)}`);
      continue;
    }

    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const type = event["type"];
    if (typeof type !== "string" || !type) continue;
    hasProtocolEvents = true;

    switch (type) {
      case "thread.started": {
        result.threadId = (event["thread_id"] as string) ?? (event["threadId"] as string) ?? null;
        break;
      }

      case "item.completed": {
        // Support both nested (real Codex) and flat (legacy) formats.
        const item = (event["item"] as Record<string, unknown>) ?? null;
        const itemType = (item?.["type"] as string) ?? (event["itemType"] as string) ?? undefined;

        if (itemType === "agent_message" || itemType === "message") {
          const text = [item?.["text"], event["text"], item?.["content"], event["content"]].find(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          if (text) result.agentMessage = text;
        } else if (itemType === "file_change") {
          const path = (item?.["path"] as string) ?? (event["path"] as string) ?? "";
          const kind = (item?.["kind"] as string) ?? (event["kind"] as string) ?? "update";
          if (path) result.fileChanges.push({ path, kind });
        } else if (itemType === "command_execution") {
          const output =
            (item?.["aggregated_output"] as string) ??
            (item?.["output"] as string) ??
            (event["output"] as string) ??
            "";
          result.commandsExecuted.push({
            command: (item?.["command"] as string) ?? (event["command"] as string) ?? "",
            exitCode:
              (item?.["exit_code"] as number) ??
              (item?.["exitCode"] as number) ??
              (event["exitCode"] as number) ??
              null,
            output: truncate(output, MAX_COMMAND_OUTPUT),
          });
        }
        break;
      }

      case "turn.completed": {
        const usage = event["usage"] as Record<string, number> | undefined;
        if (usage) {
          result.usage = {
            inputTokens: usage["input_tokens"] ?? usage["inputTokens"] ?? 0,
            outputTokens: usage["output_tokens"] ?? usage["outputTokens"] ?? 0,
          };
        }
        break;
      }

      case "turn.failed":
      case "error": {
        const error = event["error"];
        const message =
          error && typeof error === "object"
            ? (error as Record<string, unknown>)["message"]
            : error;
        const msg =
          typeof message === "string" && message.trim()
            ? message
            : typeof event["message"] === "string" && event["message"].trim()
              ? event["message"]
              : JSON.stringify(error ?? event);
        result.errors.push(msg);
        break;
      }
    }
  }

  // Preserve legacy plain text, but never turn protocol metadata into an answer.
  if (!result.agentMessage && !hasProtocolEvents && jsonlOutput.trim()) {
    result.agentMessage = jsonlOutput.trim();
  }

  if (!result.agentMessage && result.errors.length === 0) {
    result.errors.push(
      jsonlOutput.trim() ? "No agent answer in Codex CLI output" : "Empty output from Codex CLI",
    );
  }

  return result;
}
