---
name: dot-bridge
description: Control Claude Code or Codex CLI jobs on a connected local computer when the user asks dot or a local agent to delegate, check, or cancel work through the bridge.
---

Use the connected computer for bridge calls; its login, checkout and job state are local. A cloud dot needs access granted under its profile's Computers settings. If MCP tools are absent in the cloud, continue through a permitted local task using the command below. A registered local MCP server alone does not grant cloud access.

Prefer `ccb-control` tools: `bridge_doctor`, `bridge_start`, `bridge_status`, `bridge_result`, `bridge_cancel`, `bridge_list`. Start accepts `peer` (`claude` or `codex`), `prompt`, an absolute `workingDirectory`, `mode` (`read-only` default, or `implement`) and optional `timeoutSec` (5–3600). Keep the user's configured model unless they request a model override.

Local CLI command (filled by registration):

```text
{{BRIDGE_COMMAND}} control doctor
{{BRIDGE_COMMAND}} control start --peer claude --project ABSOLUTE_PROJECT_PATH --prompt-file ABSOLUTE_UTF8_PROMPT_FILE
{{BRIDGE_COMMAND}} control status JOB_ID
{{BRIDGE_COMMAND}} control result JOB_ID
{{BRIDGE_COMMAND}} control cancel JOB_ID
{{BRIDGE_COMMAND}} control list
```

Use a UTF-8 prompt file for multiline text or shell metacharacters. Add `--mode implement` only for a requested file-changing task; it grants editing tools subject to the peer's own permissions. Never infer permission to publish, push, deploy or message anyone from a request to implement code.

Start returns immediately with a job ID. Preserve it, poll status at reasonable intervals, then read the result. Do not restart merely because a job is still running. Cancel affects only the selected bridge job. Avoid concurrent implementations in one checkout and recursive calls back into this bridge.

These jobs are new independent CLI sessions. They do not attach to existing Claude chats or desktop Codex chats, and they do not control dot's own model. Use available native app tools for managing existing Codex chats when the user requests that. Report authentication, permissions or connectivity failures from the job; do not claim dot validation from a local CLI test alone.
