import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  DeterministicSourceBundleMaterializer,
  DeterministicVerificationWorker,
  MemoryArtifactStore,
  MemoryEvidenceStore,
  MemorySourceBundleStore,
  StaticVerificationProfileRegistry,
  VerificationDispatchPublisher,
  VerificationService,
  computeBundleDigest,
  createGoldenStackProfile,
  type BuilderSourceBundleEntryV1,
  type SourceBundleDescriptor,
  type VerificationRunRequest,
  type VerificationTenant,
} from "../src/index.js";
import { DockerVerificationSandboxProvisioner } from "../src/adapters/local.js";
import { PostgresVerificationStore } from "../src/adapters/postgres.js";

const postgresUrl = process.env["REEF_TEST_POSTGRES_URL"];
const sandboxImageDigest = process.env["REEF_TEST_DOCKER_IMAGE"];
const dockerHost = process.env["REEF_TEST_DOCKER_HOST"];

test(
  "real generated Next.js, FastAPI, PostgreSQL bundle passes the isolated trusted profile",
  {
    skip:
      postgresUrl === undefined || sandboxImageDigest === undefined
        ? "REEF_TEST_POSTGRES_URL and REEF_TEST_DOCKER_IMAGE are required"
        : false,
    timeout: 15 * 60_000,
  },
  async () => {
    assert.ok(postgresUrl);
    assert.match(sandboxImageDigest!, /^sha256:[0-9a-f]{64}$/);
    const tenant: VerificationTenant = {
      organisationRef: "organisation:golden-stack",
      projectRef: "project:golden-stack",
    };
    const fixtureRoot = resolve(
      dirname(new URL(import.meta.url).pathname),
      "fixtures/golden-stack",
    );
    const source = sourceBundle(fixtureRoot, tenant);
    const profile = createGoldenStackProfile(sandboxImageDigest!);
    const store = new PostgresVerificationStore(postgresUrl);
    const evidence = new MemoryEvidenceStore();
    const artifacts = new MemoryArtifactStore();
    const sourceStore = new MemorySourceBundleStore();
    sourceStore.add(source.descriptor, source.content);
    const profiles = new StaticVerificationProfileRegistry([profile]);
    const service = new VerificationService({ store, evidence, profiles });
    const workspaceRoot = mkdtempSync(
      join(process.cwd(), ".reef-verification-golden-sandbox-"),
    );
    let infrastructureError: string | undefined;

    try {
      await store.migrate();
      const request: VerificationRunRequest = {
        ...tenant,
        candidateRef: "foundation-candidate:golden-stack",
        candidateDigest: sha(Buffer.from("generated-golden-stack-v1")),
        sourceBundleRef: source.descriptor.sourceBundleRef,
        sourceBundleDigest: source.descriptor.sourceBundleDigest,
        verificationProfileRef: profile.ref,
        verificationProfileVersion: profile.version,
        verificationProfileDigest: profile.digest,
        idempotencyKey: `golden-stack-${Date.now()}`,
      };
      const created = await service.createRun(tenant, request);
      await new VerificationDispatchPublisher({
        ownerId: "golden-publisher",
        store,
        queue: store,
      }).drainOnce();
      const worker = new DeterministicVerificationWorker({
        workerId: "golden-worker",
        store,
        queue: store,
        profiles,
        materializer: new DeterministicSourceBundleMaterializer({
          store: sourceStore,
        }),
        sandboxes: new DockerVerificationSandboxProvisioner({
          root: workspaceRoot,
          user: "node",
          memory: "3g",
          cpus: "2",
          pidsLimit: 512,
          ...(dockerHost === undefined ? {} : { dockerHost }),
        }),
        artifacts,
        evidence,
        secrets: { resolve: async () => ({}) },
        leaseMs: 60_000,
        maxInfrastructureRetries: 0,
        onInfrastructureError: (error) => {
          infrastructureError =
            error instanceof Error ? error.message : String(error);
        },
      });
      assert.equal(await worker.runOnce(), true);
      const completed = await service.getRun(tenant, created.runRef);
      assert.equal(
        completed.state,
        "completed",
        `${completed.failure?.code ?? "unknown"}: ${infrastructureError ?? "no internal detail"}`,
      );
      const failedDetails = await Promise.all(
        completed.checks
          .filter((check) => check.outcome === "failed")
          .map(async (check) => ({
            checkRef: check.checkRef,
            resultCode: check.resultCode,
            output: (
              await Promise.all(
                check.artifacts.map(async (artifact) => {
                  const bytes = await artifacts.get(tenant, artifact.ref);
                  return bytes === undefined
                    ? ""
                    : Buffer.from(bytes).toString("utf8");
                }),
              )
            ).join("\n"),
          })),
      );
      assert.equal(
        completed.verdict?.outcome,
        "passed",
        JSON.stringify(failedDetails),
      );
      assert.deepEqual(
        completed.checks.map((check) => [
          check.checkRef,
          check.required,
          check.outcome,
        ]),
        profile.checks.map((check) => [
          check.checkRef,
          check.required,
          "passed",
        ]),
      );
      assert.deepEqual(
        completed.verdict?.requiredChecks,
        profile.checks.map((check) => check.checkRef),
      );
      for (const check of completed.checks) {
        const envelope = await service.resolveEvidence(
          tenant,
          check.evidenceRef,
        );
        assert.equal(envelope?.digest, check.evidenceDigest);
        assert.equal(envelope?.verifier.integrityVerified, true);
      }
      const verdict = await service.resolveEvidence(
        tenant,
        completed.verdict!.evidenceRef,
      );
      assert.equal(verdict?.digest, completed.verdict?.evidenceDigest);
      assert.equal(verdict?.verifier.integrityVerified, true);
    } finally {
      await store.close();
      if (
        workspaceRoot.startsWith(
          `${process.cwd()}${sep}.reef-verification-golden-sandbox-`,
        )
      ) {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  },
);

function sourceBundle(
  root: string,
  tenant: VerificationTenant,
): {
  descriptor: SourceBundleDescriptor;
  content: Readonly<Record<string, Uint8Array>>;
} {
  const files = walk(root);
  const content: Record<string, Uint8Array> = {};
  const entries: BuilderSourceBundleEntryV1[] = files
    .map((absolute) => {
      const path = relative(root, absolute).split(sep).join("/");
      const bytes = Uint8Array.from(readFileSync(absolute));
      const digest = sha(bytes);
      content[path] = bytes;
      return { kind: "file", path, size: bytes.byteLength, digest };
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path, "utf8"),
        Buffer.from(right.path, "utf8"),
      ),
    );
  const unsigned = {
    schemaVersion: "octopus.builder.source-bundle/v1" as const,
    ...tenant,
    candidateRef: "foundation-candidate:golden-stack",
    candidateDigest: sha(Buffer.from("generated-golden-stack-v1")),
    sourceBundleRef: "source-bundle:golden-next-fastapi-postgres",
    unicodeNormalization: "NFC" as const,
    pathSemantics: "portable-nfc-casefold-v1" as const,
    entries,
  };
  return {
    descriptor: {
      ...unsigned,
      sourceBundleDigest: computeBundleDigest(unsigned),
    },
    content,
  };
}

function walk(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(path));
    else if (entry.isFile()) result.push(path);
    else
      throw new Error(
        `golden source fixture contains a non-regular entry: ${path}`,
      );
  }
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function sha(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
