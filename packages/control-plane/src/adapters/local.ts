import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  ArtifactStore,
  GitWorkspace,
  SandboxProvisioner,
  SecretResolver,
} from "../ports.js";
import type {
  ArtifactRef,
  SandboxExecution,
  SandboxExecutionResult,
  SandboxHandle,
  SandboxSpec,
  TenantScope,
} from "../types.js";

export interface CommandRunner {
  run(
    argv: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly timeoutMs?: number;
    },
  ): Promise<SandboxExecutionResult>;
}

export const subprocessCommandRunner: CommandRunner = {
  run(argv, options = {}): Promise<SandboxExecutionResult> {
    if (argv.length === 0) throw new Error("argv must not be empty");
    return new Promise((resolveResult, reject) => {
      const child = spawn(argv[0]!, argv.slice(1), {
        shell: false,
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          LANG: process.env.LANG ?? "C.UTF-8",
          ...(process.env.LC_ALL !== undefined
            ? { LC_ALL: process.env.LC_ALL }
            : {}),
          ...(process.env.TMPDIR !== undefined
            ? { TMPDIR: process.env.TMPDIR }
            : {}),
          ...options.env,
          AWS_EC2_METADATA_DISABLED: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
      child.on("close", (code) => {
        if (timer !== undefined) clearTimeout(timer);
        resolveResult({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  },
};

class LocalSandboxHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    readonly workspacePath: string,
    private readonly runner: CommandRunner,
  ) {}

  execute(command: SandboxExecution): Promise<SandboxExecutionResult> {
    const cwd = confine(this.workspacePath, command.cwd ?? ".");
    return this.runner.run(command.argv, {
      cwd,
      env: {
        ...command.env,
        AWS_EC2_METADATA_DISABLED: "true",
      },
      ...(command.timeoutMs !== undefined
        ? { timeoutMs: command.timeoutMs }
        : {}),
    });
  }
}

/** Development adapter. It confines cwd/path ownership but is not a VM boundary. */
export class LocalSandboxProvisioner implements SandboxProvisioner {
  readonly #root: string;
  readonly #runner: CommandRunner;

  constructor(root: string, runner: CommandRunner = subprocessCommandRunner) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
    this.#runner = runner;
  }

  provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const workspace = join(this.#root, tenantKey(spec), safeId(spec.runId));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    chmodSync(workspace, 0o700);
    return Promise.resolve(
      new LocalSandboxHandle(
        `local-${safeId(spec.runId)}`,
        workspace,
        this.#runner,
      ),
    );
  }

  restore(spec: SandboxSpec, sandboxId: string): Promise<SandboxHandle> {
    const workspace = join(this.#root, tenantKey(spec), safeId(spec.runId));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    return Promise.resolve(
      new LocalSandboxHandle(sandboxId, workspace, this.#runner),
    );
  }

  destroy(_handle: SandboxHandle): Promise<void> {
    // Workspaces are intentionally retained for resume/debug; an explicit
    // retention job can delete them after artifacts/commits are durable.
    return Promise.resolve();
  }
}

export interface DockerSandboxOptions {
  readonly root: string;
  readonly image: string;
  readonly runner?: CommandRunner;
  readonly memory?: string;
  readonly cpus?: string;
  readonly pidsLimit?: number;
  readonly user?: string;
}

class DockerSandboxHandle implements SandboxHandle {
  constructor(
    readonly id: string,
    readonly workspacePath: string,
    private readonly runner: CommandRunner,
  ) {}

  execute(command: SandboxExecution): Promise<SandboxExecutionResult> {
    const cwd = normalizeContainerCwd(command.cwd);
    const env = Object.entries({
      ...command.env,
      AWS_EC2_METADATA_DISABLED: "true",
    }).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
    return this.runner.run(
      ["docker", "exec", "--workdir", cwd, ...env, this.id, ...command.argv],
      command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {},
    );
  }
}

/** Hardened reference: no network, no host namespace, one workspace mount. */
export class DockerSandboxProvisioner implements SandboxProvisioner {
  readonly #root: string;
  readonly #image: string;
  readonly #runner: CommandRunner;
  readonly #memory: string;
  readonly #cpus: string;
  readonly #pidsLimit: number;
  readonly #user: string;

  constructor(options: DockerSandboxOptions) {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    // Preserve the host spelling for Docker Desktop bind sharing (`/var` is
    // shared while macOS realpath rewrites it to `/private/var`).
    this.#root = resolve(options.root);
    this.#image = options.image;
    this.#runner = options.runner ?? subprocessCommandRunner;
    this.#memory = options.memory ?? "2g";
    this.#cpus = options.cpus ?? "2";
    this.#pidsLimit = options.pidsLimit ?? 256;
    this.#user = options.user ?? defaultDockerUser();
  }

  async provision(spec: SandboxSpec): Promise<SandboxHandle> {
    const workspace = join(this.#root, tenantKey(spec), safeId(spec.runId));
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    prepareWorkspaceOwner(workspace, this.#user);
    const name = `reef-${tenantKey(spec)}-${safeId(spec.runId)}`.slice(0, 63);
    const create = await this.#runner.run([
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
      String(this.#pidsLimit),
      "--memory",
      this.#memory,
      "--cpus",
      this.#cpus,
      "--user",
      this.#user,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=128m",
      "--env",
      "AWS_EC2_METADATA_DISABLED=true",
      "--mount",
      `type=bind,src=${workspace},dst=/workspace`,
      "--workdir",
      "/workspace",
      this.#image,
      "sleep",
      "infinity",
    ]);
    if (create.exitCode !== 0) {
      throw new Error(`docker create failed: ${create.stderr}`);
    }
    const containerId = create.stdout.trim() || name;
    const started = await this.#runner.run(["docker", "start", containerId]);
    if (started.exitCode !== 0) {
      await this.#runner.run(["docker", "rm", "-f", containerId]);
      throw new Error(`docker start failed: ${started.stderr}`);
    }
    return new DockerSandboxHandle(containerId, workspace, this.#runner);
  }

  async restore(
    spec: SandboxSpec,
    sandboxId: string,
  ): Promise<SandboxHandle | undefined> {
    const inspected = await this.#runner.run([
      "docker",
      "inspect",
      "--format",
      "{{.State.Running}}",
      sandboxId,
    ]);
    if (inspected.exitCode !== 0) return undefined;
    if (inspected.stdout.trim() !== "true") {
      const started = await this.#runner.run(["docker", "start", sandboxId]);
      if (started.exitCode !== 0) return undefined;
    }
    const workspace = join(this.#root, tenantKey(spec), safeId(spec.runId));
    return new DockerSandboxHandle(sandboxId, workspace, this.#runner);
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    const result = await this.#runner.run(["docker", "rm", "-f", handle.id]);
    if (result.exitCode !== 0 && !result.stderr.includes("No such container")) {
      throw new Error(`docker remove failed: ${result.stderr}`);
    }
  }
}

export class LocalArtifactStore implements ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#root = realpathSync(root);
  }

  put(
    scope: TenantScope,
    runId: string,
    key: string,
    content: Uint8Array,
    _contentType?: string,
  ): Promise<ArtifactRef> {
    const relativeKey = join(
      tenantKey(scope),
      safeId(runId),
      safeArtifactKey(key),
    );
    const path = confine(this.#root, relativeKey);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
    return Promise.resolve({
      ...scope,
      runId,
      key,
      uri: `file://${path}`,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }

  get(ref: ArtifactRef): Promise<Uint8Array> {
    const prefix = "file://";
    if (!ref.uri.startsWith(prefix))
      throw new Error("not a local artifact URI");
    const path = confine(
      this.#root,
      relative(this.#root, ref.uri.slice(prefix.length)),
    );
    const content = readFileSync(path);
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== ref.sha256) throw new Error("artifact checksum mismatch");
    return Promise.resolve(content);
  }
}

/** Resolves only explicit env://NAME refs at worker execution time. */
export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  resolve(
    _scope: TenantScope,
    refs: readonly { readonly name: string; readonly secretRef: string }[],
  ): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = {};
    for (const ref of refs) {
      if (!ref.secretRef.startsWith("env://")) {
        throw new Error(`unsupported local secretRef: ${ref.secretRef}`);
      }
      const envName = ref.secretRef.slice("env://".length);
      if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) {
        throw new Error(`invalid environment secretRef: ${ref.secretRef}`);
      }
      const value = this.environment[envName];
      if (value === undefined)
        throw new Error(`secretRef not found: ${ref.secretRef}`);
      resolved[ref.name] = value;
    }
    return Promise.resolve(resolved);
  }
}

export class StaticSecretResolver implements SecretResolver {
  constructor(private readonly values: Readonly<Record<string, string>>) {}

  resolve(
    _scope: TenantScope,
    refs: readonly { readonly name: string; readonly secretRef: string }[],
  ): Promise<Readonly<Record<string, string>>> {
    return Promise.resolve(
      Object.fromEntries(
        refs.map((ref) => {
          const value = this.values[ref.secretRef];
          if (value === undefined)
            throw new Error(`secretRef not found: ${ref.secretRef}`);
          return [ref.name, value];
        }),
      ),
    );
  }
}

export interface GitWorkspaceOptions {
  readonly runner?: CommandRunner;
  readonly authorName?: string;
  readonly authorEmail?: string;
}

export class GitWorktreeWorkspace implements GitWorkspace {
  readonly #runner: CommandRunner;
  readonly #authorName: string;
  readonly #authorEmail: string;
  readonly #repositories = new Map<string, string>();

  constructor(options: GitWorkspaceOptions = {}) {
    this.#runner = options.runner ?? subprocessCommandRunner;
    this.#authorName = options.authorName ?? "Octopus Reef Agent";
    this.#authorEmail = options.authorEmail ?? "agent@octopus.invalid";
  }

  async prepare(
    scope: TenantScope,
    runId: string,
    projectRef: string,
    baselineRevisionRef: string,
    workspacePath: string,
  ): Promise<{ readonly branch: string; readonly worktreePath: string }> {
    if (!isAbsolute(projectRef)) {
      throw new Error(
        "local Git projectRef must be an absolute repository path",
      );
    }
    const branch = `reef/${tenantKey(scope)}/${safeId(runId)}`;
    const existing = await this.#runner.run(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: workspacePath },
    );
    if (existing.exitCode === 0) {
      this.#repositories.set(workspaceKey(scope, runId), projectRef);
      return {
        branch: existing.stdout.trim() || branch,
        worktreePath: workspacePath,
      };
    }
    const result = await this.#runner.run(
      [
        "git",
        "worktree",
        "add",
        "-b",
        branch,
        "--",
        workspacePath,
        baselineRevisionRef,
      ],
      { cwd: projectRef },
    );
    if (result.exitCode !== 0)
      throw new Error(`git worktree add failed: ${result.stderr}`);
    this.#repositories.set(workspaceKey(scope, runId), projectRef);
    return { branch, worktreePath: workspacePath };
  }

  async commit(
    _scope: TenantScope,
    _runId: string,
    baselineRevisionRef: string,
    workspacePath: string,
    message: string,
  ): Promise<{ readonly commit: string; readonly diffRef: string }> {
    const env = {
      GIT_AUTHOR_NAME: this.#authorName,
      GIT_AUTHOR_EMAIL: this.#authorEmail,
      GIT_COMMITTER_NAME: this.#authorName,
      GIT_COMMITTER_EMAIL: this.#authorEmail,
    };
    const add = await this.#runner.run(["git", "add", "-A"], {
      cwd: workspacePath,
      env,
    });
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr}`);
    const status = await this.#runner.run(["git", "status", "--porcelain"], {
      cwd: workspacePath,
    });
    if (status.exitCode !== 0)
      throw new Error(`git status failed: ${status.stderr}`);
    if (status.stdout.trim() === "") {
      const current = await this.#runner.run(["git", "rev-parse", "HEAD"], {
        cwd: workspacePath,
      });
      if (current.exitCode !== 0)
        throw new Error(`git rev-parse failed: ${current.stderr}`);
      const commitRef = current.stdout.trim();
      return {
        commit: commitRef,
        diffRef: `${baselineRevisionRef}..${commitRef}`,
      };
    }
    const commit = await this.#runner.run(["git", "commit", "-m", message], {
      cwd: workspacePath,
      env,
    });
    if (commit.exitCode !== 0)
      throw new Error(`git commit failed: ${commit.stderr}`);
    const rev = await this.#runner.run(["git", "rev-parse", "HEAD"], {
      cwd: workspacePath,
    });
    if (rev.exitCode !== 0)
      throw new Error(`git rev-parse failed: ${rev.stderr}`);
    const commitRef = rev.stdout.trim();
    return {
      commit: commitRef,
      diffRef: `${baselineRevisionRef}..${commitRef}`,
    };
  }

  async cleanup(
    scope: TenantScope,
    runId: string,
    workspacePath: string,
  ): Promise<void> {
    const repository = this.#repositories.get(workspaceKey(scope, runId));
    if (repository === undefined) {
      throw new Error(`Git repository is unknown for run ${runId}`);
    }
    const result = await this.#runner.run(
      ["git", "worktree", "remove", "--force", workspacePath],
      { cwd: repository },
    );
    if (result.exitCode !== 0)
      throw new Error(`git worktree remove failed: ${result.stderr}`);
    this.#repositories.delete(workspaceKey(scope, runId));
  }
}

function tenantKey(scope: TenantScope): string {
  return createHash("sha256")
    .update(`${scope.organisationId}\u0000${scope.projectId}`)
    .digest("hex")
    .slice(0, 20);
}

function workspaceKey(scope: TenantScope, runId: string): string {
  return `${scope.organisationId}\u0000${scope.projectId}\u0000${runId}`;
}

function safeId(value: string): string {
  const slug = value.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${slug || "run"}-${hash}`;
}

function safeArtifactKey(key: string): string {
  const normalized = key.replaceAll("\\", "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`invalid artifact key: ${key}`);
  }
  return normalized;
}

function confine(root: string, target: string): string {
  const path = resolve(root, target);
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${target}`);
  }
  return path;
}

function normalizeContainerCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === ".") return "/workspace";
  const normalized = cwd.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`container cwd escapes workspace: ${cwd}`);
  }
  return `/workspace/${normalized}`;
}

function defaultDockerUser(): string {
  const uid = process.getuid?.() ?? 65532;
  const gid = process.getgid?.() ?? 65532;
  return `${uid === 0 ? 65532 : uid}:${gid === 0 ? 65532 : gid}`;
}

function prepareWorkspaceOwner(workspace: string, user: string): void {
  if (process.getuid?.() !== 0) return;
  const [uid, gid] = user.split(":").map(Number);
  if (
    uid !== undefined &&
    gid !== undefined &&
    Number.isInteger(uid) &&
    Number.isInteger(gid)
  ) {
    chownSync(workspace, uid, gid);
  }
}
