import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DeterministicSourceBundleMaterializer,
  computeBundleDigest,
  externalMaterializationRequest,
  parseExternalMaterializationRequest,
  portableCaseFold,
  runtimeMaterializationDescriptor,
  type ExternalMaterializationPort,
  type SourceBundleDescriptor,
  type SourceBundleStore,
  type VerificationMaterialization,
  type VerificationRun,
  type VerificationSandbox,
} from "../src/index.js";
import {
  DockerVerificationSandboxProvisioner,
  LocalSourceBundleStore,
} from "../src/adapters/local.js";

const tenant = {
  organisationRef: "organisation:materializer",
  projectRef: "project:materializer",
};
const content = Buffer.from("export const safe = true;\n", "utf8");
const baseEntry = {
  kind: "file" as const,
  path: "src/index.ts",
  size: content.byteLength,
  digest: sha(content),
};

test("source bundle runtime parser rejects hostile paths, URL refs and entry types", async () => {
  const hostile: unknown[] = [
    {
      ...descriptor([baseEntry]),
      archiveUrl: "https://storage.invalid/bundle.tar",
    },
    ...["symlink", "hardlink", "fifo", "device", "socket"].map((kind) =>
      descriptor([{ ...baseEntry, kind } as never]),
    ),
    descriptor([{ ...baseEntry, path: "/etc/passwd" }]),
    descriptor([{ ...baseEntry, path: "C:/Windows/system.ini" }]),
    descriptor([{ ...baseEntry, path: "../escape" }]),
    descriptor([{ ...baseEntry, path: "src\\escape.ts" }]),
    descriptor([{ ...baseEntry, path: "src/e\u0301.ts" }]),
    descriptor([{ ...baseEntry, path: "src/trailing." }]),
    descriptor([{ ...baseEntry, path: "src/trailing " }]),
    descriptor([
      { ...baseEntry, contentRef: "https://storage.invalid/object" } as never,
    ]),
  ];
  for (const candidate of hostile) {
    const writes: string[] = [];
    await assert.rejects(
      materialize(candidate, writes),
      /source bundle|source path|unsupported fields|opaque reference|NFC/i,
    );
    assert.deepEqual(writes, []);
  }
});

test("materializer rejects case-ambiguous paths and verifies every byte before writing", async () => {
  const duplicate = descriptor([
    {
      ...baseEntry,
      path: "SRC/INDEX.TS",
    },
    baseEntry,
  ]);
  const writes: string[] = [];
  await assert.rejects(
    materialize(duplicate, writes),
    /case-ambiguous source path/,
  );
  assert.deepEqual(writes, []);

  const wrongBytes = Buffer.from("tampered", "utf8");
  await assert.rejects(
    materialize(descriptor([baseEntry]), [], wrongBytes),
    /source materialization (?:size|digest) mismatch/,
  );

  const sameSizeTamper = Buffer.alloc(content.byteLength, 0x78);
  await assert.rejects(
    materialize(descriptor([baseEntry]), [], sameSizeTamper),
    /source materialization digest mismatch/,
  );

  const unicodeFold = descriptor([
    { ...baseEntry, path: "STRASSE.ts" },
    { ...baseEntry, path: "straße.ts" },
  ]);
  await assert.rejects(materialize(unicodeFold, []), /case-ambiguous/);
  assert.equal(portableCaseFold("straße.ts"), portableCaseFold("STRASSE.ts"));
});

test("external materialization request is exact, bounded, tenant-bound, and location-free", async () => {
  const inventory = descriptor([baseEntry]);
  const verification = run(inventory);
  const expected = externalMaterializationRequest(verification);
  const forbidden = [
    "url",
    "s3Uri",
    "bucket",
    "key",
    "command",
    "argv",
    "cwd",
    "env",
    "credentials",
    "rawCredentials",
    "secretRef",
  ];
  for (const key of forbidden) {
    assert.throws(
      () =>
        parseExternalMaterializationRequest({
          ...expected,
          [key]: key === "argv" ? ["payload"] : "payload",
        }),
      /missing or forbidden fields/,
    );
  }

  let captured: unknown;
  const port: ExternalMaterializationPort = {
    resolve: async (request) => {
      captured = request;
      return {
        inventory,
        read: async () => content,
      };
    },
  };
  const writes: string[] = [];
  const materialization = await new DeterministicSourceBundleMaterializer({
    port,
  }).materialize(verification, sandbox(writes), new AbortController().signal);
  assert.deepEqual(captured, expected);
  assert.deepEqual(writes, [baseEntry.path]);
  assert.equal(
    materialization.authoritativeSourceBundleDigest,
    inventory.sourceBundleDigest,
  );
  assert.notEqual(
    materialization.runtimeDescriptorDigest,
    materialization.authoritativeSourceBundleDigest,
  );
  assert.equal(
    materialization.ref,
    `materialization:${materialization.runtimeDescriptorDigest.slice(7)}`,
  );
  assert.doesNotMatch(
    JSON.stringify(materialization),
    /workspace|content|url|s3/i,
  );
});

test("materialization enforces count, path, file, total, and authoritative digest limits", async () => {
  const twoEntries = descriptor([
    { ...baseEntry, path: "a.ts" },
    { ...baseEntry, path: "b.ts" },
  ]);
  await assert.rejects(
    materialize(twoEntries, [], content, { maxFiles: 1 }),
    /file count/,
  );
  await assert.rejects(
    materialize(descriptor([baseEntry]), [], content, {
      maxFileBytes: content.byteLength - 1,
    }),
    /file exceeds size limit/,
  );
  await assert.rejects(
    materialize(twoEntries, [], content, {
      maxTotalBytes: content.byteLength,
    }),
    /total byte limit/,
  );
  await assert.rejects(
    materialize(descriptor([baseEntry]), [], content, { maxPathBytes: 4 }),
    /path exceeds byte limit/,
  );

  const replaced = {
    ...descriptor([baseEntry]),
    sourceBundleDigest: sha(Buffer.from("replacement")),
  };
  await assert.rejects(
    materialize(replaced, []),
    /authoritative Builder source bundle digest mismatch/,
  );
});

test("materialization fails closed on cross-identity and descriptor replacement", async () => {
  const inventory = descriptor([baseEntry]);
  const { sourceBundleDigest: ignored, ...crossTenantInput } = {
    ...inventory,
    organisationRef: "organisation:attacker",
  };
  void ignored;
  const crossTenant = {
    ...crossTenantInput,
    sourceBundleDigest: computeBundleDigest(crossTenantInput),
  };
  await assert.rejects(
    materialize(crossTenant, []),
    /Builder source bundle identity mismatch: organisationRef/,
  );

  const verification = run(inventory);
  const descriptorIdentity = runtimeMaterializationDescriptor(
    verification,
    inventory.entries,
  );
  const replacement: VerificationMaterialization = {
    schemaVersion: "octopus.reef.materialization/v1",
    ref: `materialization:${"a".repeat(64)}`,
    runtimeDescriptorDigest: `sha256:${"a".repeat(64)}`,
    authoritativeSourceBundleDigest: inventory.sourceBundleDigest,
    entryCount: descriptorIdentity.entries.length,
    totalBytes: content.byteLength,
  };
  const writes: string[] = [];
  await assert.rejects(
    materializeRun(
      { ...verification, materialization: replacement },
      inventory,
      writes,
    ),
    /descriptor replacement detected/,
  );
  assert.deepEqual(writes, []);
});

test("partial materialization cleanup removes only files created by the failed call", async () => {
  const inventory = descriptor([
    { ...baseEntry, path: "a.ts" },
    { ...baseEntry, path: "b.ts" },
    { ...baseEntry, path: "c.ts" },
  ]);
  const removed: string[] = [];
  const attempted: string[] = [];
  const target: VerificationSandbox = {
    ...sandbox([]),
    writeFile: async (path) => {
      attempted.push(path);
      if (path === "a.ts") return { created: false };
      if (path === "b.ts") return { created: true };
      throw new Error("simulated atomic sandbox write failure");
    },
    removeFiles: async (paths) => {
      removed.push(...paths);
    },
  };
  await assert.rejects(
    materializeRun(run(inventory), inventory, [], content, target),
    /simulated atomic sandbox write failure/,
  );
  assert.deepEqual(attempted, ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(removed, ["b.ts"]);
});

test("local source store rejects symlink and hardlink objects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "reef-verification-source-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new LocalSourceBundleStore(root);
  const sourceBundleRef = "source-bundle:materializer";
  const sourcePath = "src/index.ts";
  const tenantDirectory = hash(
    `${tenant.organisationRef}\0${tenant.projectRef}`,
  ).slice(0, 32);
  const objectPath = join(
    root,
    tenantDirectory,
    "objects",
    hash(`${sourceBundleRef}\0${sourcePath}`),
  );
  const backing = join(root, tenantDirectory, "objects", "backing");
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(backing, content);

  symlinkSync(backing, objectPath);
  await assert.rejects(
    store.content(tenant, sourceBundleRef, sourcePath),
    /not one regular unlinked file/,
  );
  unlinkSync(objectPath);
  linkSync(backing, objectPath);
  await assert.rejects(
    store.content(tenant, sourceBundleRef, sourcePath),
    /not one regular unlinked file/,
  );
});

test("Docker sandbox rejects root and keeps its host root private", (t) => {
  if (process.getuid?.() === undefined || process.getuid() === 0) {
    t.skip("a non-root POSIX host identity is required");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "reef-verification-docker-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(
    () => new DockerVerificationSandboxProvisioner({ root, user: "root" }),
    /must be one non-root user or UID/,
  );
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.doesNotThrow(
    () => new DockerVerificationSandboxProvisioner({ root, user: "node" }),
  );
});

test("Docker sandbox releases private command outputs before artifact reads", async (t) => {
  if (process.getuid?.() === undefined || process.getuid() === 0) {
    t.skip("a non-root POSIX host identity is required");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "reef-verification-docker-release-"));
  const bin = join(root, "bin");
  const log = join(root, "docker.log");
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_HOST"\n',
    { mode: 0o755 },
  );
  const originalPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${originalPath ?? ""}`;
  t.after(() => {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(root, { recursive: true, force: true });
  });

  const provisioner = new DockerVerificationSandboxProvisioner({
    root: join(root, "workspaces"),
    user: "node",
    dockerHost: log,
  });
  const sandbox = await provisioner.provision(
    {
      ...run(descriptor([baseEntry])),
      imageDigest: sha(Buffer.from("sandbox-image")),
    },
    new AbortController().signal,
  );
  const signal = new AbortController().signal;
  await sandbox.execute(
    {
      checkRef: "private-output",
      required: true,
      argv: ["true"],
      workingDirectory: ".",
      timeoutMs: 1_000,
      outputLimitBytes: 1_024,
      environment: {},
      tool: {
        name: "fake",
        version: "1.0.0",
        imageDigest: sha(Buffer.from("sandbox-image")),
      },
    },
    {},
    signal,
  );
  assert.equal(await sandbox.readFile("missing.log", 1_024, signal), undefined);
  await provisioner.destroy(sandbox);

  const releases = readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes("find /workspace -xdev"));
  assert.equal(releases.length, 3);
  assert.ok(releases.every((line) => line.includes("chmod g+rwX")));
  assert.ok(releases.every((line) => line.includes("! -type l")));
});

async function materialize(
  rawDescriptor: unknown,
  writes: string[],
  objectContent: Uint8Array = content,
  limits: {
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxPathBytes?: number;
  } = {},
): Promise<void> {
  await materializeRun(
    run(rawDescriptor as SourceBundleDescriptor),
    rawDescriptor,
    writes,
    objectContent,
    undefined,
    limits,
  );
}

async function materializeRun(
  verification: VerificationRun,
  rawDescriptor: unknown,
  writes: string[],
  objectContent: Uint8Array = content,
  target: VerificationSandbox = sandbox(writes),
  limits: {
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly maxTotalBytes?: number;
    readonly maxPathBytes?: number;
  } = {},
): Promise<void> {
  const store: SourceBundleStore = {
    descriptor: async () => rawDescriptor as SourceBundleDescriptor,
    content: async () => objectContent,
  };
  await new DeterministicSourceBundleMaterializer({
    store,
    ...limits,
  }).materialize(verification, target, new AbortController().signal);
}

function sandbox(writes: string[]): VerificationSandbox {
  return {
    id: "sandbox:materializer",
    workspacePath: "/not-used",
    writeFile: async (path) => {
      writes.push(path);
      return { created: true };
    },
    removeFiles: async (paths) => {
      for (const path of paths) {
        const index = writes.indexOf(path);
        if (index >= 0) writes.splice(index, 1);
      }
    },
    execute: async () => ({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      timedOut: false,
    }),
    readFile: async () => undefined,
  };
}

function descriptor(
  entries: SourceBundleDescriptor["entries"],
): SourceBundleDescriptor {
  const unsigned = {
    schemaVersion: "octopus.builder.source-bundle/v1" as const,
    ...tenant,
    candidateRef: "foundation-candidate:materializer",
    candidateDigest: sha(Buffer.from("candidate")),
    sourceBundleRef: "source-bundle:materializer",
    unicodeNormalization: "NFC" as const,
    pathSemantics: "portable-nfc-casefold-v1" as const,
    entries,
  };
  return { ...unsigned, sourceBundleDigest: computeBundleDigest(unsigned) };
}

function run(bundle: SourceBundleDescriptor): VerificationRun {
  const now = new Date(0).toISOString();
  return {
    ...tenant,
    candidateRef: "foundation-candidate:materializer",
    candidateDigest: sha(Buffer.from("candidate")),
    sourceBundleRef: bundle.sourceBundleRef,
    sourceBundleDigest: bundle.sourceBundleDigest,
    verificationProfileRef: "verification-profile:materializer",
    verificationProfileVersion: "1.0.0",
    verificationProfileDigest: sha(Buffer.from("profile")),
    runRef: "verification:materializer",
    idempotencyKey: "materializer",
    state: "running",
    version: 1,
    attempt: 1,
    eventCursor: "1",
    createdAt: now,
    updatedAt: now,
    checks: [],
  };
}

function sha(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
