import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
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
  type SourceBundleDescriptor,
  type SourceBundleStore,
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
  path: "src/index.ts",
  size: content.byteLength,
  digest: sha(content),
  contentRef: "source-object:index",
};

test("source bundle runtime parser rejects hostile paths, URL refs and entry types", async () => {
  const hostile: unknown[] = [
    {
      ...descriptor([baseEntry]),
      archiveUrl: "https://storage.invalid/bundle.tar",
    },
    descriptor([{ ...baseEntry, type: "symlink" } as never]),
    descriptor([{ ...baseEntry, path: "/etc/passwd" }]),
    descriptor([{ ...baseEntry, path: "../escape" }]),
    descriptor([{ ...baseEntry, path: "src\\escape.ts" }]),
    descriptor([{ ...baseEntry, path: "src/e\u0301.ts" }]),
    descriptor([
      { ...baseEntry, contentRef: "https://storage.invalid/object" },
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
    baseEntry,
    {
      ...baseEntry,
      path: "SRC/INDEX.TS",
      contentRef: "source-object:index-copy",
    },
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
    /source size mismatch|source digest mismatch/,
  );
});

test("local source store rejects symlink and hardlink objects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "reef-verification-source-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new LocalSourceBundleStore(root);
  const contentRef = "source-object:unsafe";
  const tenantDirectory = hash(
    `${tenant.organisationRef}\0${tenant.projectRef}`,
  ).slice(0, 32);
  const objectPath = join(root, tenantDirectory, "objects", hash(contentRef));
  const backing = join(root, tenantDirectory, "objects", "backing");
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(backing, content);

  symlinkSync(backing, objectPath);
  await assert.rejects(
    store.content(tenant, contentRef),
    /not one regular unlinked file/,
  );
  unlinkSync(objectPath);
  linkSync(backing, objectPath);
  await assert.rejects(
    store.content(tenant, contentRef),
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

async function materialize(
  rawDescriptor: unknown,
  writes: string[],
  objectContent: Uint8Array = content,
): Promise<void> {
  const store: SourceBundleStore = {
    descriptor: async () => rawDescriptor as SourceBundleDescriptor,
    content: async () => objectContent,
  };
  const sandbox: VerificationSandbox = {
    id: "sandbox:materializer",
    workspacePath: "/not-used",
    writeFile: async (path) => {
      writes.push(path);
    },
    execute: async () => ({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      timedOut: false,
    }),
    readFile: async () => undefined,
  };
  await new DeterministicSourceBundleMaterializer({ store }).materialize(
    run(rawDescriptor as SourceBundleDescriptor),
    sandbox,
    new AbortController().signal,
  );
}

function descriptor(
  entries: SourceBundleDescriptor["entries"],
): SourceBundleDescriptor {
  const unsigned = {
    schemaVersion: "reef.source-bundle.v1" as const,
    ...tenant,
    sourceBundleRef: "source-bundle:materializer",
    unicodeNormalization: "NFC" as const,
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
