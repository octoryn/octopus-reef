import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalHash, verifyEvidence, type Evidence } from "octopus-evidence";
import type {
  SourceBundleStore,
  VerificationArtifactStore,
  VerificationEvidenceStore,
  VerificationSandboxProvisioner,
  VerificationSecretResolver,
} from "../ports.js";
import type {
  SourceBundleDescriptor,
  VerificationArtifact,
  VerificationCheckDefinition,
  VerificationCommandResult,
  VerificationSandbox,
  VerificationSandboxSpec,
  VerificationTenant,
} from "../types.js";
import { assertRelativePath, assertWorkingDirectory } from "../validation.js";

export class LocalSourceBundleStore implements SourceBundleStore {
  readonly #root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
  }

  descriptor(
    tenant: VerificationTenant,
    sourceBundleRef: string,
  ): Promise<SourceBundleDescriptor> {
    const path = join(
      this.#root,
      tenantHash(tenant),
      "bundles",
      hash(sourceBundleRef),
      "descriptor.json",
    );
    return Promise.resolve(
      JSON.parse(readFileSync(confined(this.#root, path), "utf8")) as SourceBundleDescriptor,
    );
  }

  content(tenant: VerificationTenant, contentRef: string): Promise<Uint8Array> {
    const path = join(this.#root, tenantHash(tenant), "objects", hash(contentRef));
    return Promise.resolve(Uint8Array.from(readFileSync(confined(this.#root, path))));
  }
}

export class LocalVerificationArtifactStore implements VerificationArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
  }

  put(
    tenant: VerificationTenant,
    runRef: string,
    kind: string,
    mediaType: string,
    content: Uint8Array,
  ): Promise<VerificationArtifact> {
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const ref = `artifact:${hash(`${tenantHash(tenant)}\0${runRef}\0${kind}\0${digest}`)}`;
    const path = join(this.#root, tenantHash(tenant), "artifacts", hash(ref));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeContentAddressed(path, content);
    return Promise.resolve({ ref, digest, kind, mediaType, size: content.byteLength });
  }

  get(tenant: VerificationTenant, ref: string): Promise<Uint8Array | undefined> {
    const path = join(this.#root, tenantHash(tenant), "artifacts", hash(ref));
    return Promise.resolve(existsSync(path) ? Uint8Array.from(readFileSync(path)) : undefined);
  }
}

export class LocalVerificationEvidenceStore implements VerificationEvidenceStore {
  readonly #root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
  }

  put(
    tenant: VerificationTenant,
    evidence: Evidence,
  ): Promise<{ ref: string; digest: string }> {
    if (!verifyEvidence(evidence)) throw new Error("refusing invalid Evidence");
    const digest = `sha256:${canonicalHash(evidence as never)}`;
    const ref = `evidence:${evidence.id}`;
    const path = join(this.#root, tenantHash(tenant), "evidence", hash(ref));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify({ evidence, digest }), { mode: 0o600, flag: "wx" });
    }
    return Promise.resolve({ ref, digest });
  }

  get(
    tenant: VerificationTenant,
    ref: string,
  ): Promise<{ evidence: Evidence; digest: string } | undefined> {
    const path = join(this.#root, tenantHash(tenant), "evidence", hash(ref));
    if (!existsSync(path)) return Promise.resolve(undefined);
    return Promise.resolve(
      JSON.parse(readFileSync(path, "utf8")) as { evidence: Evidence; digest: string },
    );
  }
}

export class EnvironmentProfileSecretResolver implements VerificationSecretResolver {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  resolve(
    _tenant: VerificationTenant,
    bindings: readonly {
      name: string;
      secretRef: string;
      environmentName: string;
    }[],
  ): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = {};
    for (const binding of bindings) {
      if (!binding.secretRef.startsWith("env:")) {
        throw new Error(`unsupported profile-owned secretRef: ${binding.secretRef}`);
      }
      const sourceName = binding.secretRef.slice(4);
      if (!/^[A-Z][A-Z0-9_]*$/.test(sourceName)) throw new Error("invalid env secretRef");
      const value = this.#environment[sourceName];
      if (value === undefined || value === "") {
        throw new Error(`profile secret is unavailable: ${binding.name}`);
      }
      resolved[binding.environmentName] = value;
    }
    return Promise.resolve(resolved);
  }
}

export class LocalVerificationSandboxProvisioner
  implements VerificationSandboxProvisioner
{
  readonly #root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
  }

  provision(
    spec: VerificationSandboxSpec,
    _signal: AbortSignal,
  ): Promise<VerificationSandbox> {
    const workspace = join(this.#root, tenantHash(spec), hash(`${spec.runRef}\0${spec.attempt}`));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return Promise.resolve(new LocalVerificationSandbox(`local:${hash(workspace)}`, workspace));
  }

  restore(
    spec: VerificationSandboxSpec,
    sandboxRef: string,
    _signal: AbortSignal,
  ): Promise<VerificationSandbox | undefined> {
    const workspace = join(this.#root, tenantHash(spec), hash(`${spec.runRef}\0${spec.attempt}`));
    return Promise.resolve(
      existsSync(workspace)
        ? new LocalVerificationSandbox(sandboxRef, workspace)
        : undefined,
    );
  }

  destroy(_sandbox: VerificationSandbox): Promise<void> {
    // Reference adapter keeps the workspace for crash inspection. Retention is external.
    return Promise.resolve();
  }
}

class LocalVerificationSandbox implements VerificationSandbox {
  readonly workspacePath: string;

  constructor(
    readonly id: string,
    workspacePath: string,
  ) {
    this.workspacePath = realpathSync(workspacePath);
  }

  writeFile(path: string, content: Uint8Array, signal: AbortSignal): Promise<void> {
    abort(signal);
    const target = safeWorkspacePath(this.workspacePath, path, false);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    rejectSymlinkAncestors(this.workspacePath, target);
    writeContentAddressed(target, content);
    return Promise.resolve();
  }

  execute(
    check: VerificationCheckDefinition,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<VerificationCommandResult> {
    const cwd = safeWorkspacePath(this.workspacePath, check.workingDirectory, true);
    return spawnBounded(check.argv, cwd, environment, check.timeoutMs, check.outputLimitBytes, signal);
  }

  readFile(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    abort(signal);
    const target = safeWorkspacePath(this.workspacePath, path, true);
    if (!existsSync(target)) return Promise.resolve(undefined);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
      throw new Error(`verification artifact is unsafe or oversized: ${path}`);
    }
    const real = realpathSync(target);
    confined(this.workspacePath, real);
    return Promise.resolve(Uint8Array.from(readFileSync(real)));
  }
}

export interface DockerVerificationSandboxOptions {
  readonly root: string;
  readonly user?: string;
  readonly memory?: string;
  readonly cpus?: string;
  readonly pidsLimit?: number;
}

export class DockerVerificationSandboxProvisioner
  implements VerificationSandboxProvisioner
{
  readonly #root: string;
  readonly #options: DockerVerificationSandboxOptions;

  constructor(options: DockerVerificationSandboxOptions) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.#root = resolve(options.root);
    this.#options = options;
  }

  async provision(
    spec: VerificationSandboxSpec,
    signal: AbortSignal,
  ): Promise<VerificationSandbox> {
    abort(signal);
    const workspace = join(this.#root, tenantHash(spec), hash(`${spec.runRef}\0${spec.attempt}`));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    chmodSync(workspace, 0o777);
    const name = `reef-verification-${hash(`${tenantHash(spec)}\0${spec.runRef}\0${spec.attempt}`).slice(0, 32)}`;
    const created = await runProcess(
      [
        "docker",
        "create",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        String(this.#options.pidsLimit ?? 256),
        "--memory",
        this.#options.memory ?? "2g",
        "--cpus",
        this.#options.cpus ?? "2",
        "--user",
        this.#options.user ?? "65532:65532",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=128m",
        "--env",
        "AWS_EC2_METADATA_DISABLED=true",
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        spec.imageDigest,
        "sh",
        "-c",
        "trap : TERM INT; sleep infinity & wait",
      ],
      process.cwd(),
      {},
      120_000,
      1024 * 1024,
      signal,
    );
    if (created.exitCode !== 0) {
      throw new Error(`docker sandbox create failed: ${Buffer.from(created.stderr).toString("utf8")}`);
    }
    const started = await runProcess(
      ["docker", "start", name],
      process.cwd(),
      {},
      30_000,
      1024 * 1024,
      signal,
    );
    if (started.exitCode !== 0) throw new Error("docker sandbox start failed");
    return new DockerVerificationSandbox(name, workspace);
  }

  async restore(
    spec: VerificationSandboxSpec,
    sandboxRef: string,
    signal: AbortSignal,
  ): Promise<VerificationSandbox | undefined> {
    const inspected = await runProcess(
      ["docker", "inspect", "--format", "{{.State.Running}}", sandboxRef],
      process.cwd(),
      {},
      10_000,
      1024,
      signal,
    );
    if (inspected.exitCode !== 0 || Buffer.from(inspected.stdout).toString("utf8").trim() !== "true") {
      return undefined;
    }
    const workspace = join(this.#root, tenantHash(spec), hash(`${spec.runRef}\0${spec.attempt}`));
    return new DockerVerificationSandbox(sandboxRef, workspace);
  }

  async destroy(sandbox: VerificationSandbox): Promise<void> {
    await runProcess(
      ["docker", "rm", "--force", sandbox.id],
      process.cwd(),
      {},
      30_000,
      1024 * 1024,
      new AbortController().signal,
    );
  }
}

class DockerVerificationSandbox extends LocalVerificationSandbox {
  constructor(id: string, workspacePath: string) {
    super(id, workspacePath);
  }

  override execute(
    check: VerificationCheckDefinition,
    environment: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<VerificationCommandResult> {
    const containerCwd =
      check.workingDirectory === "." ? "/workspace" : `/workspace/${check.workingDirectory}`;
    const envArgs = Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]);
    return runProcess(
      ["docker", "exec", "--workdir", containerCwd, ...envArgs, this.id, ...check.argv],
      process.cwd(),
      {},
      check.timeoutMs,
      check.outputLimitBytes,
      signal,
      () => {
        const killer = spawn("docker", ["kill", this.id], { stdio: "ignore" });
        killer.unref();
      },
    );
  }
}

async function spawnBounded(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
): Promise<VerificationCommandResult> {
  return runProcess([...argv], cwd, environment, timeoutMs, outputLimit, signal);
}

function runProcess(
  argv: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  timeoutMs: number,
  outputLimit: number,
  signal: AbortSignal,
  onAbort?: () => void,
): Promise<VerificationCommandResult> {
  abort(signal);
  mkdirSync(join(cwd, ".reef-home"), { recursive: true, mode: 0o700 });
  return new Promise((resolveResult, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: join(cwd, ".reef-home"),
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        AWS_EC2_METADATA_DISABLED: "true",
        ...environment,
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let timedOut = false;
    let settled = false;
    const capture = (chunks: Buffer[], chunk: Buffer, current: number): number => {
      const remaining = Math.max(0, outputLimit - current);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return current + chunk.byteLength;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize = capture(stdout, chunk, stdoutSize);
      if (stdoutSize > outputLimit) killTree(child.pid);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize = capture(stderr, chunk, stderrSize);
      if (stderrSize > outputLimit) killTree(child.pid);
    });
    const abortChild = (): void => {
      onAbort?.();
      killTree(child.pid);
    };
    signal.addEventListener("abort", abortChild, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abortChild);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abortChild);
      if (signal.aborted) {
        reject(signal.reason ?? new Error("verification aborted"));
        return;
      }
      resolveResult({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout: Uint8Array.from(Buffer.concat(stdout)),
        stderr: Uint8Array.from(Buffer.concat(stderr)),
        timedOut,
      });
    });
  });
}

function safeWorkspacePath(root: string, path: string, allowExisting: boolean): string {
  if (path === ".") assertWorkingDirectory(path);
  else assertRelativePath(path);
  const target = confined(root, resolve(root, path));
  if (allowExisting && existsSync(target)) {
    const real = realpathSync(target);
    confined(root, real);
  }
  return target;
}

function writeContentAddressed(path: string, content: Uint8Array): void {
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (
      existing.byteLength !== content.byteLength ||
      !createHash("sha256").update(existing).digest().equals(
        createHash("sha256").update(content).digest(),
      )
    ) {
      throw new Error("content-addressed verification object conflicts with existing content");
    }
    return;
  }
  writeFileSync(path, content, { mode: 0o600, flag: "wx" });
}

function rejectSymlinkAncestors(root: string, target: string): void {
  let current = dirname(target);
  while (current !== root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("source path traverses a symlink");
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("source path escapes workspace");
    current = parent;
  }
}

function confined(root: string, target: string): string {
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("path escapes verification workspace");
  }
  return target;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("verification aborted");
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // Child may already have exited.
  }
}

function tenantHash(tenant: VerificationTenant): string {
  return hash(`${tenant.organisationRef}\0${tenant.projectRef}`).slice(0, 32);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
