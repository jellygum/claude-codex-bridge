import { describe, it, expect } from "vitest";
import { parseClaudeOutput } from "../src/lib/claude-output-parser.js";

describe("parseClaudeOutput", () => {
  it("parses result as string", () => {
    const json = JSON.stringify({
      result: "The answer is 42.",
      session_id: "s-123",
    });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toBe("The answer is 42.");
    expect(result.sessionId).toBe("s-123");
    expect(result.errors).toHaveLength(0);
  });

  it("preserves JSON answer text in a successful result envelope", () => {
    const answer = '{"type":"result","is_error":true}';
    const result = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        errors: [],
        result: answer,
      }),
    );
    expect(result.resultText).toBe(answer);
    expect(result.errors).toEqual([]);
  });

  it("parses result with content array", () => {
    const json = JSON.stringify({
      result: {
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "World" },
        ],
      },
    });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toBe("Hello \nWorld");
  });

  it("falls back to raw text when JSON parsing fails", () => {
    const result = parseClaudeOutput("This is plain text output");
    expect(result.resultText).toBe("This is plain text output");
    expect(result.errors).toHaveLength(0);
  });

  it("handles empty output", () => {
    const result = parseClaudeOutput("");
    expect(result.resultText).toBe("");
    expect(result.errors).toContain("Empty output from Claude CLI");
  });

  it("extracts error field", () => {
    const json = JSON.stringify({
      error: "Authentication failed",
      result: "",
    });

    const result = parseClaudeOutput(json);
    expect(result.errors).toContain("Authentication failed");
  });

  it("extracts cost_usd", () => {
    const json = JSON.stringify({
      result: "Done",
      cost_usd: 0.05,
    });

    const result = parseClaudeOutput(json);
    expect(result.costUsd).toBe(0.05);
  });

  it("handles nested error object", () => {
    const json = JSON.stringify({
      error: { message: "Rate limit exceeded", code: 429 },
    });

    const result = parseClaudeOutput(json);
    expect(result.errors).toContain("Rate limit exceeded");
  });

  it("reports max-turn errors without returning the protocol object as an answer", () => {
    const result = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["QA_MAX_TURNS"],
        result: "",
      }),
    );
    expect(result.resultText).toBe("");
    expect(result.errors).toEqual(["QA_MAX_TURNS"]);
  });

  it.each([
    [{ is_error: true }, "Claude CLI reported an error"],
    [{ subtype: "error_max_turns" }, "error_max_turns"],
    [{ errors: [{ message: "QA_ERROR" }, { code: "QA_CODE" }] }, "QA_ERROR"],
  ])("recognizes explicit errors independently (%j)", (fields, message) => {
    const result = parseClaudeOutput(JSON.stringify({ type: "result", result: "", ...fields }));
    expect(result.resultText).toBe("");
    expect(result.errors).toContain(message);
    expect(result.errors.every((error) => typeof error === "string")).toBe(true);
  });

  it.each([
    { type: "result", subtype: "success", is_error: false, result: "", errors: [] },
    { type: "system", message: "Protocol metadata" },
    { session_id: "qa", cost_usd: 0 },
    { result: { content: [{ type: "text", text: "   " }] } },
  ])("rejects structured output without answer text (%j)", (output) => {
    const result = parseClaudeOutput(JSON.stringify(output));
    expect(result.resultText.trim()).toBe("");
    expect(result.errors).toEqual(["No agent answer in Claude CLI output"]);
  });

  it("preserves a nonempty result alongside an explicit failure", () => {
    const result = parseClaudeOutput(
      JSON.stringify({
        type: "result",
        is_error: true,
        result: "Partial answer",
        errors: ["QA_ERROR"],
      }),
    );
    expect(result.resultText).toBe("Partial answer");
    expect(result.errors).toEqual(["QA_ERROR"]);
  });

  it.each(["null", "42", '"JSON string"'])("preserves legacy JSON text (%s)", (text) => {
    expect(parseClaudeOutput(text).resultText).toBe(text);
  });

  it("stringifies response when no result field found", () => {
    const json = JSON.stringify({ data: "some unexpected format" });

    const result = parseClaudeOutput(json);
    expect(result.resultText).toContain("some unexpected format");
  });
});
