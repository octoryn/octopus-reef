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
  computeBuilderSourceBundleDigest,
  createGoldenStackProfile,
  type BuilderSourceBundleFileV1,
  type SourceBundleDescriptor,
  type VerificationRunRequest,
  type VerificationSandbox,
  type VerificationTenant,
} from "../src/index.js";
import { DockerVerificationSandboxProvisioner } from "../src/adapters/local.js";
import { PostgresVerificationStore } from "../src/adapters/postgres.js";

const postgresUrl = process.env["REEF_TEST_POSTGRES_URL"];
const sandboxImageDigest = process.env["REEF_TEST_DOCKER_IMAGE"];
const dockerHost = process.env["REEF_TEST_DOCKER_HOST"];

test(
  "isolated Docker sandbox denies host, peer, and IMDS access",
  {
    skip:
      sandboxImageDigest === undefined
        ? "REEF_TEST_DOCKER_IMAGE is required"
        : false,
    timeout: 2 * 60_000,
  },
  async () => {
    assert.match(sandboxImageDigest!, /^sha256:[0-9a-f]{64}$/);
    const workspaceRoot = mkdtempSync(
      join(process.cwd(), ".reef-verification-network-sandbox-"),
    );
    const provisioner = new DockerVerificationSandboxProvisioner({
      root: workspaceRoot,
      user: "node",
      memory: "1g",
      cpus: "1",
      pidsLimit: 128,
      ...(dockerHost === undefined ? {} : { dockerHost }),
    });
    let sandbox: VerificationSandbox | undefined;
    try {
      sandbox = await provisioner.provision(
        {
          organisationRef: "organisation:network-isolation",
          projectRef: "project:network-isolation",
          candidateRef: "foundation-candidate:network-isolation",
          candidateDigest: sha(Buffer.from("network-candidate")),
          sourceBundleRef: "source-bundle:network-isolation",
          sourceBundleDigest: sha(Buffer.from("network-source")),
          verificationProfileRef: "verification-profile:network-isolation",
          verificationProfileVersion: "1.0.0",
          verificationProfileDigest: sha(Buffer.from("network-profile")),
          runRef: "verification:network-isolation",
          attempt: 1,
          imageDigest: sandboxImageDigest!,
        },
        new AbortController().signal,
      );
      const result = await sandbox.execute(
        {
          checkRef: "network-isolation",
          required: true,
          argv: [
            "node",
            "-e",
            [
              "if (process.env.AWS_EC2_METADATA_DISABLED !== 'true') process.exit(2);",
              "const urls=['http://host.docker.internal:1','http://172.17.0.1:1','http://169.254.169.254/latest/meta-data/'];",
              "Promise.all(urls.map(async url=>{",
              "  try { await fetch(url,{signal:AbortSignal.timeout(1000)}); throw new Error('network reachable: '+url); }",
              "  catch (error) { if (String(error).includes('network reachable')) throw error; }",
              "})).then(()=>process.exit(0),error=>{console.error(String(error));process.exit(3)});",
            ].join("\n"),
          ],
          workingDirectory: ".",
          timeoutMs: 10_000,
          outputLimitBytes: 16 * 1024,
          environment: {},
          tool: {
            name: "golden-stack-sandbox",
            version: "0.4.1",
            imageDigest: sandboxImageDigest!,
          },
        },
        {},
        new AbortController().signal,
      );
      assert.equal(
        result.exitCode,
        0,
        Buffer.from(result.stderr).toString("utf8"),
      );
    } finally {
      if (sandbox !== undefined) await provisioner.destroy(sandbox);
      if (
        workspaceRoot.startsWith(
          `${process.cwd()}${sep}.reef-verification-network-sandbox-`,
        )
      ) {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  },
);

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
        sourceBundleRef: source.descriptor.bundleRef,
        sourceBundleDigest: source.descriptor.digest,
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
  const inventory: BuilderSourceBundleFileV1[] = files
    .map((absolute) => {
      const path = relative(root, absolute).split(sep).join("/");
      const bytes = Uint8Array.from(readFileSync(absolute));
      const digest = sha(bytes);
      content[path] = bytes;
      return { path, sizeBytes: bytes.byteLength, contentDigest: digest };
    })
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
  const digest = computeBuilderSourceBundleDigest(inventory);
  return {
    descriptor: {
      schemaVersion: "octopus.builder.source-bundle/v1" as const,
      ...tenant,
      bundleRef: `source-bundle:${digest}`,
      digest,
      inventory,
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
