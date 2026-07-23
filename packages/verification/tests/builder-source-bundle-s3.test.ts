import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  AwsS3BuilderSourceBundleMaterializationPort,
  builderSourceBundleS3ObjectLayout,
  type BuilderSourceBundleS3Client,
} from "../src/adapters/builder-source-bundle-s3.js";
import {
  DeterministicSourceBundleMaterializer,
  computeBuilderSourceBundleDigest,
  externalMaterializationRequest,
  parseBuilderSourceBundleDescriptor,
  type VerificationRun,
  type VerificationSandbox,
} from "../src/index.js";

const fixtureRoot = new URL("./fixtures/builder-v1-s3/", import.meta.url);
const contract = JSON.parse(
  readFileSync(new URL("contract.json", fixtureRoot), "utf8"),
) as {
  readonly canonicalInventoryJson: string;
  readonly authoritativeDigest: string;
  readonly descriptorUtf8Bytes: number;
  readonly descriptorKey: string;
  readonly blobKeys: readonly string[];
};
const descriptorBytes = readFileSync(
  new URL(contract.descriptorKey, fixtureRoot),
);
const descriptor = JSON.parse(descriptorBytes.toString("utf8")) as {
  readonly schemaVersion: "octopus.builder.source-bundle/v1";
  readonly organisationRef: string;
  readonly projectRef: string;
  readonly bundleRef: string;
  readonly digest: string;
  readonly inventory: readonly {
    readonly path: string;
    readonly contentDigest: string;
    readonly sizeBytes: number;
  }[];
};
const location = {
  bucket: "deployment-owned-builder-bundles",
  prefix: "manufacturing/source-bundles",
  expectedBucketOwner: "123456789012",
};

test("Builder frozen Phase 1 fixture preserves authoritative bytes, digest and S3 layout", async () => {
  assert.equal(descriptorBytes.byteLength, contract.descriptorUtf8Bytes);
  assert.equal(
    computeBuilderSourceBundleDigest(descriptor.inventory),
    contract.authoritativeDigest,
  );
  assert.equal(descriptor.digest, contract.authoritativeDigest);
  assert.equal(descriptor.bundleRef, `source-bundle:${descriptor.digest}`);
  assert.equal(
    JSON.stringify({
      schemaVersion: descriptor.schemaVersion,
      files: descriptor.inventory,
    }),
    contract.canonicalInventoryJson,
  );
  const layout = builderSourceBundleS3ObjectLayout(
    location,
    descriptor,
    descriptor.bundleRef,
  );
  assert.equal(layout.descriptorKey, contract.descriptorKey);
  assert.deepEqual(
    descriptor.inventory.map((entry) => layout.blobKey(entry.contentDigest)),
    contract.blobKeys,
  );

  const client = fixtureClient();
  const seenTenants: unknown[] = [];
  const port = new AwsS3BuilderSourceBundleMaterializationPort({
    resolver: {
      resolve: (tenant) => {
        seenTenants.push(tenant);
        return location;
      },
    },
    client,
  });
  const writes = new Map<string, Uint8Array>();
  const materialization = await new DeterministicSourceBundleMaterializer({
    port,
  }).materialize(run(), sandbox(writes), new AbortController().signal);

  assert.deepEqual(seenTenants, [
    {
      organisationRef: descriptor.organisationRef,
      projectRef: descriptor.projectRef,
    },
  ]);
  assert.deepEqual([...writes.keys()], ["README.md", "src/app.ts"]);
  assert.equal(materialization.builderSourceBundleRef, descriptor.bundleRef);
  assert.equal(materialization.builderSourceBundleDigest, descriptor.digest);
  assert.notEqual(
    materialization.builderSourceBundleBindingDigest,
    descriptor.digest,
  );
  assert.notEqual(materialization.runtimeDescriptorDigest, descriptor.digest);
  assert.notEqual(
    materialization.runtimeDescriptorDigest,
    materialization.builderSourceBundleBindingDigest,
  );
  assert.ok(
    client.calls.every(
      (call) =>
        call.input.Bucket === location.bucket &&
        call.input.ExpectedBucketOwner === location.expectedBucketOwner,
    ),
  );
});

test("Builder v1 parsing stays exact while Reef binds a separate portable path policy", async () => {
  const bytes = Buffer.from("portable policy is separate\n");
  const inventory = [
    {
      path: "accepted-by-builder.",
      contentDigest: shaBytes(bytes),
      sizeBytes: bytes.byteLength,
    },
  ];
  const digest = computeBuilderSourceBundleDigest(inventory);
  const exactBuilderDescriptor = {
    schemaVersion: "octopus.builder.source-bundle/v1" as const,
    organisationRef: "bare-tenant",
    projectRef: "bare-project",
    bundleRef: `source-bundle:${digest}`,
    digest,
    inventory,
  };
  assert.deepEqual(
    parseBuilderSourceBundleDescriptor(exactBuilderDescriptor),
    exactBuilderDescriptor,
  );

  const exactRun = {
    ...run(),
    organisationRef: exactBuilderDescriptor.organisationRef,
    projectRef: exactBuilderDescriptor.projectRef,
    sourceBundleRef: exactBuilderDescriptor.bundleRef,
    sourceBundleDigest: exactBuilderDescriptor.digest,
  };
  const materializer = new DeterministicSourceBundleMaterializer({
    port: {
      resolve: async () => ({
        descriptor: exactBuilderDescriptor,
        read: async () => bytes,
      }),
    },
  });
  await assert.rejects(
    materializer.materialize(
      exactRun,
      sandbox(new Map()),
      new AbortController().signal,
    ),
    /source bundle path is not a canonical NFC relative path/,
  );
});

test("adapter rejects the 0.3 collision shape, relabels and identity replacement", async () => {
  const request = externalMaterializationRequest(run());
  const collision = {
    schemaVersion: "octopus.builder.source-bundle/v1",
    organisationRef: descriptor.organisationRef,
    projectRef: descriptor.projectRef,
    candidateRef: request.candidateRef,
    candidateDigest: request.candidateDigest,
    sourceBundleRef: request.sourceBundleRef,
    sourceBundleDigest: request.sourceBundleDigest,
    unicodeNormalization: "NFC",
    pathSemantics: "portable-nfc-casefold-v1",
    entries: [],
  };
  const replacements = [
    collision,
    { ...descriptor, organisationRef: "organisation/attacker" },
    { ...descriptor, projectRef: "project/attacker" },
    { ...descriptor, digest: sha("relabel") },
    { ...descriptor, bundleRef: `source-bundle:${sha("replacement")}` },
  ];
  for (const replacement of replacements) {
    const client = fixtureClient({
      [contract.descriptorKey]: Buffer.from(JSON.stringify(replacement)),
    });
    const port = new AwsS3BuilderSourceBundleMaterializationPort({
      resolver: { resolve: () => location },
      client,
    });
    await assert.rejects(
      port.resolve(request, new AbortController().signal),
      /descriptor|source bundle|unsupported fields|ref\/digest/i,
    );
  }
});

test("trusted mapping isolates tenants and external requests cannot select S3 locations", async () => {
  const request = externalMaterializationRequest(run());
  const client = fixtureClient();
  const port = new AwsS3BuilderSourceBundleMaterializationPort({
    resolver: { resolve: () => location },
    client,
  });
  await assert.rejects(
    port.resolve(
      { ...request, bucket: "attacker" } as never,
      new AbortController().signal,
    ),
    /missing or forbidden fields/,
  );
  await assert.rejects(
    port.resolve(
      { ...request, organisationRef: "organisation/attacker" },
      new AbortController().signal,
    ),
    /fixture object missing/,
  );
  assert.ok(
    client.calls.every((call) => call.input.Bucket === location.bucket),
  );
  assert.ok(
    client.calls.every(
      (call) => !String(call.input.Key).includes("organisation/"),
    ),
  );
});

test("blob swaps, missing objects, partial streams and descriptor byte limits fail closed", async () => {
  const request = externalMaterializationRequest(run());
  const target = descriptor.inventory[0]!;
  const targetKey = contract.blobKeys[0]!;
  for (const replacement of [
    Buffer.alloc(target.sizeBytes - 1, 0x78),
    Buffer.alloc(target.sizeBytes, 0x78),
    Buffer.alloc(target.sizeBytes + 1, 0x78),
  ]) {
    const client = fixtureClient({ [targetKey]: replacement });
    const resolved = await new AwsS3BuilderSourceBundleMaterializationPort({
      resolver: { resolve: () => location },
      client,
    }).resolve(request, new AbortController().signal);
    await assert.rejects(
      resolved.read(target.path, new AbortController().signal),
      /integrity|byte limit/,
    );
  }

  const missing = fixtureClient({}, new Set([targetKey]));
  const missingResolved = await new AwsS3BuilderSourceBundleMaterializationPort(
    {
      resolver: { resolve: () => location },
      client: missing,
    },
  ).resolve(request, new AbortController().signal);
  await assert.rejects(
    missingResolved.read(target.path, new AbortController().signal),
    /fixture object missing/,
  );

  const bounded = new AwsS3BuilderSourceBundleMaterializationPort({
    resolver: { resolve: () => location },
    client: fixtureClient(),
    maxDescriptorBytes: descriptorBytes.byteLength - 1,
  });
  await assert.rejects(
    bounded.resolve(request, new AbortController().signal),
    /byte limit/,
  );
});

test("restart and duplicate delivery resolve the same immutable identity; unreferenced blobs are ignored", async () => {
  const extraKey = `${contract.descriptorKey}/../blobs/${"f".repeat(64)}`;
  const client = fixtureClient({ [extraKey]: Buffer.from("orphan") });
  const options = {
    resolver: { resolve: () => location },
    client,
  };
  const first = await new AwsS3BuilderSourceBundleMaterializationPort(
    options,
  ).resolve(
    externalMaterializationRequest(run()),
    new AbortController().signal,
  );
  const second = await new AwsS3BuilderSourceBundleMaterializationPort(
    options,
  ).resolve(
    externalMaterializationRequest(run()),
    new AbortController().signal,
  );
  assert.deepEqual(first.descriptor, second.descriptor);
  assert.equal(
    Buffer.compare(
      Buffer.from(await first.read("README.md", new AbortController().signal)),
      Buffer.from(await second.read("README.md", new AbortController().signal)),
    ),
    0,
  );
  assert.equal(
    client.calls.some((call) => call.input.Key === extraKey),
    false,
    "orphan blobs are not authoritative and are never read",
  );
});

class FixtureS3Client implements BuilderSourceBundleS3Client {
  readonly calls: GetObjectCommand[] = [];

  constructor(
    private readonly objects: ReadonlyMap<string, Uint8Array>,
    private readonly missing: ReadonlySet<string>,
  ) {}

  async send(command: GetObjectCommand): Promise<never> {
    this.calls.push(command);
    const key = String(command.input.Key);
    if (this.missing.has(key) || !this.objects.has(key)) {
      throw new Error("fixture object missing");
    }
    const bytes = this.objects.get(key)!;
    async function* body(): AsyncIterable<Uint8Array> {
      const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
      yield bytes.subarray(0, midpoint);
      yield bytes.subarray(midpoint);
    }
    return { Body: body() } as never;
  }
}

function fixtureClient(
  replacements: Readonly<Record<string, Uint8Array>> = {},
  missing: ReadonlySet<string> = new Set(),
): FixtureS3Client {
  const objects = new Map<string, Uint8Array>();
  objects.set(contract.descriptorKey, descriptorBytes);
  for (const key of contract.blobKeys) {
    objects.set(key, readFileSync(new URL(key, fixtureRoot)));
  }
  for (const [key, value] of Object.entries(replacements)) {
    objects.set(key, value);
  }
  return new FixtureS3Client(objects, missing);
}

function run(): VerificationRun {
  return {
    organisationRef: descriptor.organisationRef,
    projectRef: descriptor.projectRef,
    candidateRef: "foundation-candidate:phase-1",
    candidateDigest: sha("phase-1-candidate"),
    sourceBundleRef: descriptor.bundleRef,
    sourceBundleDigest: descriptor.digest,
    verificationProfileRef: "verification-profile:golden-eight",
    verificationProfileVersion: "0.4.0",
    verificationProfileDigest: sha("golden-eight-profile"),
    runRef: "verification:builder-v1-fixture",
    idempotencyKey: "builder-v1-fixture",
    state: "running",
    version: 1,
    attempt: 1,
    eventCursor: "1",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    checks: [],
  };
}

function sandbox(writes: Map<string, Uint8Array>): VerificationSandbox {
  return {
    id: "sandbox:builder-v1",
    workspacePath: "/not-exposed",
    writeFile: async (path, bytes) => {
      const existing = writes.get(path);
      if (existing !== undefined) {
        assert.deepEqual(existing, bytes);
        return { created: false };
      }
      writes.set(path, Uint8Array.from(bytes));
      return { created: true };
    },
    removeFiles: async (paths) => {
      for (const path of paths) writes.delete(path);
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

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function shaBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
