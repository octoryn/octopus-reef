#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface VerificationSandboxRunnerOptions {
  readonly authToken: string;
  readonly workspacePath: string;
  readonly maxBodyBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxTimeoutMs?: number;
}

export function createVerificationSandboxRunnerHandler(
  options: VerificationSandboxRunnerOptions,
): RequestListener {
  if (Buffer.byteLength(options.authToken, "utf8") < 32) {
    throw new Error("verification sandbox auth token must contain at least 32 bytes");
  }
  mkdirSync(options.workspacePath, { recursive: true, mode: 0o700 });
  const root = realpathSync(options.workspacePath);
  let executing = false;
  return (request, response): void => {
    if (request.method === "GET" && request.url === "/readyz") {
      json(response, 200, { ready: true, service: "reef-verification-sandbox" });
      return;
    }
    if (!authorized(request, options.authToken)) return json(response, 401, { error: "unauthorized" });
    if (request.method !== "POST") return json(response, 404, { error: "not found" });
    void readJson(request, options.maxBodyBytes ?? 16 * 1024 * 1024)
      .then(async (body) => {
        if (request.url === "/v1/files/write") return write(root, body, options);
        if (request.url === "/v1/files/read") return read(root, body, options);
        if (request.url === "/v1/execute") {
          if (executing) throw new RunnerHttpError(429, "a verification check is already running");
          executing = true;
          try { return await execute(root, body, request, options); }
          finally { executing = false; }
        }
        throw new RunnerHttpError(404, "not found");
      })
      .then((body) => json(response, 200, body))
      .catch((error: unknown) => json(
        response,
        error instanceof RunnerHttpError ? error.status : 400,
        { error: error instanceof Error ? error.message : String(error) },
      ));
  };
}

export function createVerificationSandboxRunnerServer(
  options: VerificationSandboxRunnerOptions,
): Server {
  return createServer(createVerificationSandboxRunnerHandler(options));
}

function write(
  root: string,
  body: unknown,
  options: VerificationSandboxRunnerOptions,
): { readonly written: number; readonly digest: string } {
  const record = object(body);
  const path = string(record, "path");
  const encoded = string(record, "contentBase64");
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64") !== encoded || content.byteLength > (options.maxFileBytes ?? 64 * 1024 * 1024)) {
    throw new Error("sandbox file content is invalid or oversized");
  }
  const target = safePath(root, path, false);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  rejectSymlinkAncestors(root, target);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (!digest(existing).equals(digest(content))) throw new Error("sandbox file identity conflict");
  } else {
    writeFileSync(target, content, { mode: 0o600, flag: "wx" });
  }
  return { written: content.byteLength, digest: `sha256:${digest(content).toString("hex")}` };
}

function read(
  root: string,
  body: unknown,
  options: VerificationSandboxRunnerOptions,
): { readonly found: boolean; readonly contentBase64?: string } {
  const record = object(body);
  const path = string(record, "path");
  const maxBytes = integer(record, "maxBytes", options.maxFileBytes ?? 64 * 1024 * 1024);
  const target = safePath(root, path, true);
  if (!existsSync(target)) return { found: false };
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw new Error("sandbox artifact is unsafe or oversized");
  }
  return { found: true, contentBase64: readFileSync(realpathSync(target)).toString("base64") };
}

async function execute(
  root: string,
  body: unknown,
  request: IncomingMessage,
  options: VerificationSandboxRunnerOptions,
): Promise<{
  readonly exitCode: number;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly timedOut: boolean;
}> {
  const record = object(body);
  const argv = stringArray(record, "argv");
  const cwdValue = string(record, "workingDirectory");
  const cwd = cwdValue === "." ? root : safePath(root, cwdValue, true);
  const timeoutMs = integer(record, "timeoutMs", options.maxTimeoutMs ?? 30 * 60_000);
  const outputLimit = integer(record, "outputLimitBytes", options.maxOutputBytes ?? 16 * 1024 * 1024);
  const environment = stringRecord(record["environment"]);
  const abort = new AbortController();
  request.once("close", () => abort.abort(new Error("verification worker disconnected")));
  const result = await run(argv, cwd, environment, timeoutMs, outputLimit, abort.signal);
  return {
    exitCode: result.exitCode,
    stdoutBase64: result.stdout.toString("base64"),
    stderrBase64: result.stderr.toString("base64"),
    timedOut: result.timedOut,
  };
}

function run(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; timedOut: boolean }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp/reef-home", TMPDIR: "/tmp", LANG: "C.UTF-8",
        AWS_EC2_METADATA_DISABLED: "true", ...safeEnvironment(environment),
      },
    });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    let stdoutBytes = 0; let stderrBytes = 0; let timedOut = false; let settled = false;
    const capture = (list: Buffer[], chunk: Buffer, bytes: number): number => {
      const remaining = Math.max(0, outputLimit - bytes);
      if (remaining > 0) list.push(chunk.subarray(0, remaining));
      if (bytes + chunk.byteLength > outputLimit) kill(child.pid);
      return bytes + chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdoutBytes = capture(stdout, chunk, stdoutBytes); });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes = capture(stderr, chunk, stderrBytes); });
    const abort = (): void => kill(child.pid);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; kill(child.pid); }, timeoutMs);
    child.once("error", (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.once("close", (code) => {
      if (settled) return; settled = true; cleanup();
      if (signal.aborted) return reject(signal.reason ?? new Error("verification aborted"));
      resolveResult({ exitCode: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), timedOut });
    });
    function cleanup(): void { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  });
}

function safeEnvironment(value: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name.startsWith("AWS_") || name.startsWith("REEF_") ||
      name === "NODE_OPTIONS" || name === "LD_PRELOAD" || name === "LD_LIBRARY_PATH") {
      throw new Error(`unsafe sandbox environment variable: ${name}`);
    }
    if (item.length > 8192) throw new Error(`sandbox environment value is too large: ${name}`);
    result[name] = item;
  }
  return result;
}

function safePath(root: string, path: string, existing: boolean): string {
  if (path === "" || path === "." || isAbsolute(path) || path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    path.normalize("NFC") !== path) throw new Error("sandbox path is not canonical and relative");
  const target = resolve(root, path);
  confined(root, target);
  if (existing && existsSync(target)) confined(root, realpathSync(target));
  return target;
}

function rejectSymlinkAncestors(root: string, target: string): void {
  let current = dirname(target);
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("sandbox path traverses symlink");
    current = dirname(current);
  }
}

function confined(root: string, target: string): void {
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("sandbox path escapes workspace");
  }
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = request.headers.authorization;
  if (!actual?.startsWith("Bearer ")) return false;
  const a = Buffer.from(actual.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.byteLength;
    if (size > maxBytes) throw new RunnerHttpError(413, "sandbox request is too large");
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) { throw new RunnerHttpError(400, "sandbox request must be JSON", { cause: error }); }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("sandbox request must be an object");
  return value as Record<string, unknown>;
}

function string(record: Record<string, unknown>, key: string): string {
  const value = record[key]; if (typeof value !== "string" || value === "") throw new Error(`${key} must be a string`); return value;
}

function integer(record: Record<string, unknown>, key: string, maximum: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new Error(`${key} is out of bounds`);
  return value as number;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 128 ||
    value.some((item) => typeof item !== "string" || item === "" || item.length > 32_768)) throw new Error(`${key} is invalid`);
  return value as string[];
}

function stringRecord(value: unknown): Record<string, string> {
  const record = object(value); const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") throw new Error("environment values must be strings"); result[key] = item;
  }
  return result;
}

function digest(value: Uint8Array): Buffer { return createHash("sha256").update(value).digest(); }
function kill(pid: number | undefined): void { if (pid !== undefined) try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } }
function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body));
}

class RunnerHttpError extends Error {
  constructor(readonly status: number, message: string, options?: ErrorOptions) { super(message, options); }
}

async function main(): Promise<void> {
  const authToken = sandboxAuthToken(process.env);
  mkdirSync("/tmp/reef-home", { recursive: true, mode: 0o700 });
  const server = createVerificationSandboxRunnerServer({
    authToken,
    workspacePath: process.env["REEF_VERIFICATION_SANDBOX_WORKSPACE"] ?? "/workspace",
  });
  const port = Number(process.env["PORT"] ?? "8081");
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject); server.listen(port, "0.0.0.0", resolveListen);
  });
  await new Promise<void>((resolveStop) => { process.once("SIGINT", resolveStop); process.once("SIGTERM", resolveStop); });
  await new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));
}

function sandboxAuthToken(environment: NodeJS.ProcessEnv): string {
  const direct = environment["REEF_VERIFICATION_SANDBOX_AUTH_TOKEN"];
  if (direct !== undefined) return direct;
  const shared = environment["REEF_VERIFICATION_SANDBOX_SHARED_SECRET"];
  const runRef = environment["REEF_VERIFICATION_RUN_REF"];
  const attempt = environment["REEF_VERIFICATION_ATTEMPT"];
  const imageDigest = environment["REEF_VERIFICATION_IMAGE_DIGEST"];
  if (shared === undefined || runRef === undefined || attempt === undefined || imageDigest === undefined) {
    throw new Error("verification sandbox authentication configuration is incomplete");
  }
  return createHmac("sha256", shared)
    .update(`${runRef}\0${attempt}\0${imageDigest}`)
    .digest("base64url");
}

if (process.argv[1] !== undefined && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
