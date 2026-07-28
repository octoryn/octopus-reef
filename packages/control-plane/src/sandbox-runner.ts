#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prepareSourceWorkspace } from "./source-workspace.js";
import { finalizeCandidate } from "./candidate-finalize.js";
import type {
  SandboxExecution,
  SandboxExecutionResult,
  SandboxFinalizeRequest,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_TIMEOUT_MS = 15 * 60_000;

export interface SandboxRunnerOptions {
  readonly authToken: string;
  readonly workspacePath: string;
  readonly maxBodyBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxTimeoutMs?: number;
  /** AWS region used to sign the candidate CodeCommit push during finalise. */
  readonly codeCommitRegion?: string;
}

/** Private per-task command endpoint for the Fargate sandbox adapter. */
export function createSandboxRunnerHandler(
  options: SandboxRunnerOptions,
): RequestListener {
  if (options.authToken.length < 32) {
    throw new Error("sandbox runner auth token must contain at least 32 bytes");
  }
  mkdirSync(options.workspacePath, { recursive: true, mode: 0o700 });
  const workspacePath = realpathSync(options.workspacePath);
  let running = false;

  return (request, response): void => {
    if (
      request.method === "GET" &&
      (request.url === "/healthz" || request.url === "/readyz")
    ) {
      json(response, 200, {
        ready: true,
        service: "reef-sandbox-runner",
        workspacePath,
      });
      return;
    }
    const isExecute = request.method === "POST" && request.url === "/v1/execute";
    const isFinalize =
      request.method === "POST" && request.url === "/v1/finalize";
    if (!isExecute && !isFinalize) {
      json(response, 404, { error: "not found" });
      return;
    }
    if (!authorized(request, options.authToken)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (running) {
      json(response, 429, { error: "sandbox command already running" });
      return;
    }
    running = true;
    const handled = isFinalize
      ? readJson(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
          .then((body) => finalizeRequestFromBody(body))
          .then((finalizeRequest) =>
            finalizeCandidate({
              workspacePath,
              request: finalizeRequest,
              ...(options.codeCommitRegion !== undefined
                ? { region: options.codeCommitRegion }
                : {}),
            }),
          )
      : readJson(request, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES)
          .then((body) => commandFromBody(body))
          .then((command) => execute(workspacePath, command, options));
    void handled
      .then((result) => json(response, 200, result))
      .catch((error: unknown) => {
        json(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
}

export function createSandboxRunnerServer(
  options: SandboxRunnerOptions,
): Server {
  return createServer(createSandboxRunnerHandler(options));
}

async function execute(
  workspacePath: string,
  command: SandboxExecution,
  options: SandboxRunnerOptions,
): Promise<SandboxExecutionResult> {
  const cwd = confinedCwd(workspacePath, command.cwd ?? ".");
  const maxTimeout = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const timeoutMs = Math.min(command.timeoutMs ?? maxTimeout, maxTimeout);
  const maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return new Promise((resolveResult, reject) => {
    const child = spawn(command.argv[0]!, command.argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnvironment(command.env),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const capture = (
      chunks: Buffer[],
      chunk: Buffer,
      bytes: number,
    ): number => {
      const remaining = Math.max(0, maxOutput - bytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return bytes + chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = capture(stdout, chunk, stdoutBytes);
      if (stdoutBytes > maxOutput) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = capture(stderr, chunk, stderrBytes);
      if (stderrBytes > maxOutput) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      settled = true;
      reject(error);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolveResult({
        exitCode: code ?? 124,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr:
          Buffer.concat(stderr).toString("utf8") +
          (signal === "SIGKILL" ? "\ncommand terminated by sandbox limit" : ""),
      });
    });
  });
}

function childEnvironment(
  requested: Readonly<Record<string, string>> | undefined,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp/reef-home",
    TMPDIR: "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    AWS_EC2_METADATA_DISABLED: "true",
  };
  for (const [name, value] of Object.entries(requested ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name.startsWith("AWS_") ||
      name.startsWith("REEF_") ||
      name === "NODE_OPTIONS" ||
      name === "LD_PRELOAD" ||
      name === "LD_LIBRARY_PATH"
    ) {
      continue;
    }
    environment[name] = value;
  }
  return environment;
}

function commandFromBody(value: unknown): SandboxExecution {
  const record = object(value);
  const nested = "command" in record ? object(record["command"]) : record;
  const argv = nested["argv"];
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > 256 ||
    argv.some((part) => typeof part !== "string" || part.length > 65_536)
  ) {
    throw new Error("command.argv must be a non-empty string array");
  }
  const cwd = nested["cwd"];
  if (cwd !== undefined && typeof cwd !== "string") {
    throw new Error("command.cwd must be a string");
  }
  const timeoutMs = nested["timeoutMs"];
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)
  ) {
    throw new Error("command.timeoutMs must be a positive integer");
  }
  const rawEnv = nested["env"];
  let env: Record<string, string> | undefined;
  if (rawEnv !== undefined) {
    const candidate = object(rawEnv);
    env = {};
    for (const [name, value] of Object.entries(candidate)) {
      if (typeof value !== "string") {
        throw new Error("command.env values must be strings");
      }
      env[name] = value;
    }
  }
  return {
    argv: argv as string[],
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
  };
}

function finalizeRequestFromBody(value: unknown): SandboxFinalizeRequest {
  const record = object(value);
  const nested =
    "finalize" in record ? object(record["finalize"]) : record;
  const candidateBranch = nested["candidateBranch"];
  if (typeof candidateBranch !== "string" || candidateBranch === "") {
    throw new Error("finalize.candidateBranch must be a non-empty string");
  }
  const commitMessage = nested["commitMessage"];
  if (typeof commitMessage !== "string" || commitMessage === "") {
    throw new Error("finalize.commitMessage must be a non-empty string");
  }
  const push = nested["push"];
  if (push !== undefined && typeof push !== "boolean") {
    throw new Error("finalize.push must be a boolean");
  }
  const timeoutMs = nested["timeoutMs"];
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1)
  ) {
    throw new Error("finalize.timeoutMs must be a positive integer");
  }
  const rawTest = nested["testCommand"];
  const testCommand =
    rawTest === undefined ? undefined : commandFromBody(rawTest);
  return {
    candidateBranch,
    commitMessage,
    ...(testCommand !== undefined ? { testCommand } : {}),
    ...(push !== undefined ? { push } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
  };
}

/**
 * Resolve the AWS region used to sign the candidate CodeCommit push. Prefer the
 * region sealed into the source binding (same repository the candidate is
 * pushed to); fall back to the ambient AWS region.
 */
function codeCommitRegionFromEnvironment(): string | undefined {
  const raw = process.env["REEF_SOURCE_BINDING"]?.trim();
  if (raw !== undefined && raw !== "") {
    try {
      const binding = JSON.parse(raw) as { readonly git?: { region?: unknown } };
      const region = binding.git?.region;
      if (typeof region === "string" && region !== "") return region;
    } catch {
      // Ignore; fall through to the ambient region.
    }
  }
  const ambient = (
    process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"]
  )?.trim();
  return ambient === undefined || ambient === "" ? undefined : ambient;
}

function confinedCwd(workspacePath: string, requested: string): string {
  if (requested === "" || isAbsolute(requested)) {
    throw new Error("command.cwd must be relative to the sandbox workspace");
  }
  const resolved = resolve(workspacePath, requested);
  const path = relative(workspacePath, resolved);
  if (
    path === ".." ||
    path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("command.cwd escapes the sandbox workspace");
  }
  return resolved;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const prefix = "Bearer ";
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith(prefix)) {
    return false;
  }
  const actual = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error("request body exceeds sandbox runner limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("request body must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Consume the Builder source binding delivered over the run metadata channel
 * (via `REEF_SOURCE_BINDING`) and clone the sealed revision into the sandbox
 * workspace before serving any command. Absent binding -> no-op (dev/local git
 * worktree flow owns the workspace). Present but invalid, out-of-scope, or an
 * unclonable binding -> throw so the task exits non-zero and the run fails
 * closed rather than executing against an empty or wrong workspace.
 */
async function materialiseSourceWorkspace(
  workspacePath: string,
): Promise<void> {
  const raw = process.env["REEF_SOURCE_BINDING"]?.trim();
  if (raw === undefined || raw === "") return;
  let binding: unknown;
  try {
    binding = JSON.parse(raw);
  } catch {
    throw new Error("REEF_SOURCE_BINDING must be a JSON source binding");
  }
  const prepared = await prepareSourceWorkspace({
    binding,
    scope: {
      organisationId: required("REEF_ORGANISATION_ID"),
      projectId: required("REEF_PROJECT_ID"),
    },
    workspacePath,
    ...(process.env["REEF_SOURCE_GIT_CREDENTIAL_HELPER"]?.trim()
      ? {
          credentialHelper:
            process.env["REEF_SOURCE_GIT_CREDENTIAL_HELPER"]!.trim(),
        }
      : {}),
  });
  process.stdout.write(
    `reef-sandbox-runner materialised source ${prepared.revision} ` +
      `(${prepared.cloned ? "cloned" : "reused"}) into ${workspacePath}\n`,
  );
}

async function main(): Promise<void> {
  const authToken = required("REEF_SANDBOX_AUTH_TOKEN");
  const workspacePath = process.env["REEF_SANDBOX_WORKSPACE"] ?? "/workspace";
  mkdirSync("/tmp/reef-home", { recursive: true, mode: 0o700 });
  await materialiseSourceWorkspace(workspacePath);
  const codeCommitRegion = codeCommitRegionFromEnvironment();
  const server = createSandboxRunnerServer({
    authToken,
    workspacePath,
    ...(codeCommitRegion !== undefined ? { codeCommitRegion } : {}),
  });
  const host = process.env["REEF_SANDBOX_HOST"] ?? "0.0.0.0";
  const port = integer("REEF_SANDBOX_PORT", 8081);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  process.stdout.write(`reef-sandbox-runner listening on ${host}:${port}\n`);
  await new Promise<void>((resolveStop) => {
    process.once("SIGINT", resolveStop);
    process.once("SIGTERM", resolveStop);
  });
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) =>
      error === undefined ? resolveClose() : reject(error),
    );
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "")
    throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return value;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
