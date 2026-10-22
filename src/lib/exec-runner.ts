import { spawn, execFile } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { peerInvocation } from "./cli-paths.js";
import { BridgeError } from "./errors.js";
import { logger } from "./logger.js";
import type { ExecOptions, ExecResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_BRIDGE_DEPTH = 2;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 10_000;

function getTimeoutMs(): number {
  const env = process.env["BRIDGE_TIMEOUT_MS"];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

function getMaxRetries(): number {
  const env = process.env["BRIDGE_MAX_RETRIES"];
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_MAX_RETRIES;
}

function checkRecursionDepth(): void {
  const depth = parseInt(process.env["BRIDGE_DEPTH"] ?? "0", 10);
  if (depth >= MAX_BRIDGE_DEPTH) {
    throw new BridgeError(
      `Maximum bridge nesting depth reached (${depth} >= ${MAX_BRIDGE_DEPTH}). This prevents infinite recursion between Claude and Codex.`,
      "RECURSION_LIMIT",
    );
  }
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

const TRANSIENT_PATTERNS = [
  "rate limit",
  "too many requests",
  "429",
  "500",
  "502",
  "503",
  "504",
  "internal server error",
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "connection reset",
  "connection refused",
  "econnreset",
  "econnrefused",
  "etimedout",
  "network error",
  "fetch failed",
  "socket hang up",
];

export function isTransientError(result: ExecResult): boolean {
  if (result.exitCode === 0) return false;
  if (result.timedOut) return false;
  if (result.cancelled) return false;
  const stderr = result.stderr.toLowerCase();
  return TRANSIENT_PATTERNS.some((pattern) => stderr.includes(pattern));
}

function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

// ---------------------------------------------------------------------------
// Core exec (single attempt)
// ---------------------------------------------------------------------------

function execOnce(options: ExecOptions): Promise<ExecResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: true,
    });
  }
  const timeoutMs = options.timeoutMs ?? getTimeoutMs();
  const currentDepth = parseInt(process.env["BRIDGE_DEPTH"] ?? "0", 10);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
    BRIDGE_DEPTH: String(currentDepth + 1),
  };
  delete env["CLAUDECODE"];
  // npm launchers use /usr/bin/env node, even when this bridge was started with
  // an absolute Node path from a non-login SSH/MCP environment.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const overridePathKey = Object.keys(options.env ?? {}).find(
    (key) => key.toLowerCase() === "path",
  );
  const inheritedPath = overridePathKey
    ? options.env![overridePathKey]
    : (env["PATH"] ?? (pathKey ? env[pathKey] : undefined));
  // Windows can expose Path; duplicate PATH/Path keys make spawn pick one by
  // lexical order. Normalize once without losing the inherited search path.
  for (const key of Object.keys(env)) {
    if (key !== "PATH" && key.toLowerCase() === "path") delete env[key];
  }
  env["PATH"] = [inheritedPath, dirname(process.execPath)].filter(Boolean).join(delimiter);

  return new Promise((resolve, reject) => {
    logger.debug(
      `exec: ${options.command} ${options.args.join(" ")} (cwd: ${options.cwd ?? process.cwd()}, timeout: ${timeoutMs}ms)`,
    );

    let child;
    try {
      const invocation =
        options.command === "claude" || options.command === "codex"
          ? peerInvocation(options.command, options.args, env)
          : { command: options.command, args: options.args };
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd ?? process.cwd(),
        env,
        windowsHide: true,
        // Own a separate process group so cancellation also stops CLI subprocesses.
        detached: process.platform !== "win32",
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new BridgeError(
          `Failed to spawn "${options.command}": ${err instanceof Error ? err.message : String(err)}`,
          "CLI_NOT_FOUND",
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const killPosixGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
      }
    };
    const stop = () => {
      if (settled || forceTimer) return;
      if (process.platform === "win32" && child.pid) {
        execFile(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
          () => {
            if (!settled) child.kill();
          },
        );
      } else killPosixGroup("SIGTERM");
      forceTimer = setTimeout(() => {
        if (process.platform === "win32") child.kill("SIGKILL");
        else killPosixGroup("SIGKILL");
      }, 5_000);
      forceTimer.unref();
    };
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (typeof options.onStdout === "function") {
        options.onStdout(chunk);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (typeof options.onStderr === "function") {
        options.onStderr(chunk);
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      logger.warn(`Process timed out after ${timeoutMs}ms, sending SIGTERM`);
      stop();
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      settled = true;
      if (err.code === "ENOENT") {
        reject(
          new BridgeError(
            `"${options.command}" not found. Is it installed and on your PATH?`,
            "CLI_NOT_FOUND",
          ),
        );
      } else {
        reject(new BridgeError(`Process error: ${err.message}`, "PROCESS_ERROR", err.code));
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (forceTimer && process.platform !== "win32") killPosixGroup("SIGKILL");
      clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      settled = true;
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
        cancelled,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API — exec with automatic retry on transient errors
// ---------------------------------------------------------------------------

export async function execCommand(options: ExecOptions): Promise<ExecResult> {
  checkRecursionDepth();

  const maxRetries = options.maxRetries ?? getMaxRetries();

  for (let attempt = 0; ; attempt++) {
    const result = await execOnce(options);

    if (attempt < maxRetries && isTransientError(result)) {
      const delay = retryDelayMs(attempt);
      logger.warn(
        `Transient error detected (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms...`,
      );
      await sleep(delay, options.signal);
      continue;
    }

    return result;
  }
}
