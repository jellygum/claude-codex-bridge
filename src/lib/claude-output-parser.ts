import { logger } from "./logger.js";
import type { ClaudeResult } from "./types.js";

/**
 * Parses the JSON output from `claude -p --output-format json`.
 * The output is a single JSON object with a `result` field containing
 * the response content.
 */
export function parseClaudeOutput(jsonOutput: string): ClaudeResult {
  const result: ClaudeResult = {
    resultText: "",
    sessionId: null,
    costUsd: null,
    errors: [],
  };

  const trimmed = jsonOutput.trim();
  if (!trimmed) {
    result.errors.push("Empty output from Claude CLI");
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Claude may have output plain text instead of JSON
    logger.debug("Failed to parse Claude output as JSON, using raw text");
    result.resultText = trimmed;
    return result;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.resultText = trimmed;
    return result;
  }

  // Extract result text from structured output
  // Claude JSON format: { result: string, ... } or { result: { content: [...] }, ... }
  const resultField = parsed["result"];
  if (typeof resultField === "string") {
    result.resultText = resultField;
  } else if (resultField && typeof resultField === "object") {
    const content = (resultField as Record<string, unknown>)["content"] as
      | Array<Record<string, unknown>>
      | undefined;
    if (Array.isArray(content)) {
      result.resultText = content
        .filter((c) => c && c["type"] === "text" && typeof c["text"] === "string")
        .map((c) => c["text"] as string)
        .join("\n");
    }
  }

  // Error indicators are authoritative even when the CLI exits successfully.
  const errors = [parsed["error"], ...(Array.isArray(parsed["errors"]) ? parsed["errors"] : [])];
  for (const error of errors) {
    if (!error) continue;
    const message =
      typeof error === "object" ? (error as Record<string, unknown>)["message"] : error;
    result.errors.push(
      typeof message === "string" && message.trim() ? message : JSON.stringify(error),
    );
  }
  const subtype = typeof parsed["subtype"] === "string" ? parsed["subtype"] : "";
  const isError =
    parsed["is_error"] === true || subtype.startsWith("error") || result.errors.length > 0;
  if (isError && result.errors.length === 0) {
    result.errors.push(
      [subtype, result.resultText.trim()].filter(Boolean).join(": ") ||
        "Claude CLI reported an error",
    );
  }

  // Keep legacy answer fields, but do not read messages from metadata/error events.
  if (!result.resultText.trim() && !isError && (!parsed["type"] || parsed["type"] === "result")) {
    result.resultText =
      [parsed["message"], parsed["text"], parsed["output"]].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ) ?? "";
  }

  const hasProtocolFields = [
    "type",
    "result",
    "subtype",
    "is_error",
    "error",
    "errors",
    "session_id",
    "sessionId",
    "cost_usd",
    "costUsd",
    "total_cost_usd",
    "usage",
  ].some((key) => key in parsed);
  if (!result.resultText.trim() && !hasProtocolFields && Object.keys(parsed).length > 0) {
    result.resultText = JSON.stringify(parsed, null, 2);
  }

  // Extract metadata
  result.sessionId = (parsed["session_id"] as string) ?? (parsed["sessionId"] as string) ?? null;
  result.costUsd = (parsed["cost_usd"] as number) ?? (parsed["costUsd"] as number) ?? null;

  if (!result.resultText.trim() && result.errors.length === 0) {
    result.errors.push("No agent answer in Claude CLI output");
  }

  return result;
}
