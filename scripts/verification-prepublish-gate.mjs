#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const controlPlane = json("packages/control-plane/package.json");
const verification = json("packages/verification/package.json");

assert(
  controlPlane.name === "@octopus-reef/control-plane",
  "control-plane package identity drifted",
);
assert(
  controlPlane.version === "0.4.0",
  "control-plane release must be exactly 0.4.0",
);
assert(
  verification.name === "@octopus-reef/verification",
  "verification package identity drifted",
);
assert(
  verification.version === "0.4.0",
  "verification release must be exactly 0.4.0",
);
assert(
  controlPlane.dependencies?.["@octopus-reef/verification"] === "0.4.0",
  "control-plane must declare the exact formal verification compatibility version",
);

for (const subpath of [
  "./verification",
  "./verification/client",
  "./verification/materialization",
  "./verification/production",
  "./verification/adapters/postgres",
  "./verification/adapters/local",
  "./verification/adapters/aws",
  "./verification/adapters/builder-source-bundle-s3",
])
  assert(
    controlPlane.exports?.[subpath] !== undefined,
    `missing control-plane export ${subpath}`,
  );

const dockerfile = text("packages/verification/Dockerfile");
for (const target of ["api", "worker"]) {
  assert(
    dockerfile.includes(`FROM runtime AS ${target}`),
    `missing verification ${target} image target`,
  );
}
assert(
  dockerfile.includes("USER node"),
  "verification images must not run as root",
);
assert(
  dockerfile.includes(
    'ENTRYPOINT ["node", "/app/packages/verification/dist/bin.js"]',
  ),
  "verification image entrypoint drifted",
);

const readme = text("packages/verification/README.md");
for (const method of [
  "createRun",
  "getRun",
  "streamRunEvents",
  "retryRun",
  "cancelRun",
]) {
  assert(
    readme.includes(`\`${method}\``),
    `compatibility documentation omits ${method}`,
  );
}
for (const forbidden of ["`command`", "`argv`", "raw credential", "AgentRun"]) {
  assert(
    readme.includes(forbidden),
    `security boundary documentation omits ${forbidden}`,
  );
}
for (const marker of [
  "octopus.builder.source-bundle/v1",
  "octopus.reef.builder-source-bundle-binding/v1",
  "octopus.reef.materialization-descriptor/v2",
  "octopus.reef.materialization/v2",
  'JSON.stringify({schemaVersion:"octopus.builder.source-bundle/v1",files})',
]) {
  assert(
    readme.includes(marker),
    `Builder v1 compatibility documentation omits ${marker}`,
  );
}
assert(
  verification.exports?.["./adapters/builder-source-bundle-s3"] !== undefined,
  "verification package omits the Builder v1 S3 adapter export",
);

const workflow = text(".github/workflows/verification-release.yml");
for (const marker of [
  "npm publish --provenance",
  "publish-package-gate.json",
  'gh api "repos/${GITHUB_REPOSITORY}" --jq',
  "linux/amd64,linux/arm64",
  "anchore/sbom-action",
  "aquasecurity/trivy-action@a9c7b0f06e461e9d4b4d1711f154ee024b8d7ab8",
  "vnd.docker.reference.type",
  "verification-release-record.json",
  "REEF_TEST_DOCKER_IMAGE",
  "docker compose",
  'if type == "array" then . else [.] end',
  "PROFILE_REPOSITORY",
  "golden-profile.json",
  "npm rebuild better-sqlite3",
  "0003_builder_v1_binding",
  "--draft",
  ".immutable == true",
])
  assert(workflow.includes(marker), `release workflow omits ${marker}`);
assert(
  !workflow.includes("--prerelease"),
  "0.4.0 Release must not be a prerelease",
);

const verificationDockerfile = text("packages/verification/Dockerfile");
for (const marker of [
  "node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e",
  "apt-get upgrade -y",
  "rm -rf /usr/local/lib/node_modules/npm",
]) {
  assert(
    verificationDockerfile.includes(marker),
    `Verification image hardening omits ${marker}`,
  );
}
const goldenDockerfile = text(
  "packages/verification/tests/fixtures/golden-stack/Dockerfile.sandbox",
);
assert(
  goldenDockerfile.includes("npm@12.0.1"),
  "Golden Stack image omits the pinned patched npm runtime",
);
assert(
  goldenDockerfile.includes("/etc/ssl/private/ssl-cert-snakeoil.key"),
  "Golden Stack image does not remove the package-generated snakeoil private key",
);
const remoteSandboxDockerfile = text(
  "packages/verification/Dockerfile.remote-sandbox",
);
assert(
  remoteSandboxDockerfile.includes("ARG REEF_VERIFICATION_API_IMAGE\n") &&
    !remoteSandboxDockerfile.includes("ARG REEF_VERIFICATION_API_IMAGE="),
  "remote sandbox must require the current immutable API image",
);
assert(
  text("scripts/write-verification-remote-profile.mjs").includes(
    'version: "1.2.0"',
  ),
  "remote Golden Stack profile version drifted",
);

const goldenAcceptance = text(
  "packages/verification/tests/docker-golden-stack.integration.test.ts",
);
for (const marker of [
  "Next.js",
  "FastAPI",
  "PostgreSQL",
  "DockerVerificationSandboxProvisioner",
]) {
  assert(
    goldenAcceptance.includes(marker),
    `Golden Stack acceptance omits ${marker}`,
  );
}

const goldenProfile = text("packages/verification/src/golden-profile.ts");
for (const marker of [
  "verification-profile:golden-next-fastapi-postgres",
  "frontend-production-build",
  "backend-tests",
  "postgres-migration-repeat",
  "application-health",
])
  assert(
    goldenProfile.includes(marker),
    `published Golden Stack profile omits ${marker}`,
  );

run("npm", ["run", "build", "--workspace", "@octopus-reef/verification"]);
run("npx", ["tsc", "-b", "packages/control-plane", "--pretty", "false"]);
run("npm", ["audit", "--audit-level=high"]);
run("npm", ["audit", "signatures"]);

const migrationAssets = [
  {
    id: "0001_verification",
    asset: "migrations/0001_verification.sql",
    sql: text("packages/verification/migrations/0001_verification.sql"),
  },
  {
    id: "0002_materialization",
    asset: "migrations/0002_materialization.sql",
    sql: text("packages/verification/migrations/0002_materialization.sql"),
  },
  {
    id: "0003_builder_v1_binding",
    asset: "migrations/0003_builder_v1_binding.sql",
    sql: text("packages/verification/migrations/0003_builder_v1_binding.sql"),
  },
];
const runtimeMigrationModule = await import(
  pathToFileURL(join(root, "packages/verification/dist/adapters/migrations.js"))
    .href
);
const runtimeMigrations = runtimeMigrationModule.VERIFICATION_MIGRATIONS;
assert(
  Array.isArray(runtimeMigrations) &&
    runtimeMigrations.length === migrationAssets.length &&
    runtimeMigrations.every(
      (migration, index) => migration.id === migrationAssets[index]?.id,
    ),
  "runtime migration identity drifted",
);
for (const [index, migration] of runtimeMigrations.entries()) {
  assert(
    migration.sql === migrationAssets[index]?.sql,
    `runtime migration bytes differ for ${migration.id}`,
  );
}

const temporary = mkdtempSync(
  join(tmpdir(), "reef-verification-package-gate-"),
);
try {
  const verificationPack = pack("@octopus-reef/verification", temporary);
  const controlPlanePack = pack("@octopus-reef/control-plane", temporary);
  assert(
    verificationPack.files.some((file) => file.path === "README.md"),
    "verification tarball is missing README.md",
  );
  assert(
    verificationPack.files.some(
      (file) => file.path === "migrations/0001_verification.sql",
    ),
    "verification tarball is missing its PostgreSQL migration",
  );
  assert(
    verificationPack.files.some(
      (file) => file.path === "migrations/0002_materialization.sql",
    ),
    "verification tarball is missing its materialization migration",
  );
  assert(
    verificationPack.files.some(
      (file) => file.path === "migrations/0003_builder_v1_binding.sql",
    ),
    "verification tarball is missing its Builder v1 binding migration",
  );
  assert(
    verificationPack.files.some((file) => file.path === "dist/bin.js"),
    "verification tarball is missing its executable entrypoint",
  );
  assert(
    controlPlanePack.files.some(
      (file) => file.path === "dist/verification-client.js",
    ),
    "control-plane tarball is missing its verification client compatibility export",
  );
  assert(
    controlPlanePack.files.some(
      (file) => file.path === "dist/verification-materialization.js",
    ),
    "control-plane tarball is missing its materialization compatibility export",
  );
  assert(
    controlPlanePack.files.some((file) => file.path === "dist/bin.js"),
    "control-plane tarball is missing its executable entrypoint",
  );

  const verificationTarball = join(temporary, verificationPack.filename);
  const controlPlaneTarball = join(temporary, controlPlanePack.filename);
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--package-lock=false",
      verificationTarball,
      controlPlaneTarball,
    ],
    temporary,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "import { VerificationHttpClient } from '@octopus-reef/control-plane/verification/client';",
        "const required = ['createRun','getRun','streamRunEvents','retryRun','cancelRun','resolveEvidence'];",
        "for (const method of required) {",
        "  if (typeof VerificationHttpClient.prototype[method] !== 'function') throw new Error('missing '+method);",
        "}",
        "const pkg = await import('@octopus-reef/control-plane/verification');",
        "if (typeof pkg.VerificationService !== 'function') throw new Error('missing verification core export');",
        "const materialization = await import('@octopus-reef/control-plane/verification/materialization');",
        "const adapter = await import('@octopus-reef/control-plane/verification/adapters/builder-source-bundle-s3');",
        "if (typeof materialization.computeBuilderSourceBundleDigest !== 'function') throw new Error('missing Builder v1 digest adapter');",
        "if (typeof adapter.AwsS3BuilderSourceBundleMaterializationPort !== 'function') throw new Error('missing Builder v1 S3 adapter');",
        "const digest = materialization.computeBuilderSourceBundleDigest([",
        "  {path:'README.md',contentDigest:'sha256:3ff7d0ee673d132b4c46e68fe806da4a31269d1d95a6219a91d5fa7eb25e9b69',sizeBytes:22},",
        "  {path:'src/app.ts',contentDigest:'sha256:4c9a2a851c102d1e1fe2ebb20defb6a0332b9b5c431a0fd644fe21712c412c6a',sizeBytes:27}",
        "]);",
        "if (digest !== 'sha256:dc4f26d4717eb33cb448a4edc1fa8150c4f140fb7db5cad9fe3e1503ce25333d') throw new Error('Builder v1 frozen digest drifted');",
      ].join("\n"),
    ],
    temporary,
  );
  copyFileSync(
    join(root, "scripts/verification-public-package-blackbox.mjs"),
    join(temporary, "verification-public-package-blackbox.mjs"),
  );
  run(
    process.execPath,
    ["verification-public-package-blackbox.mjs"],
    temporary,
  );

  const migrationSetDigest = sha256(
    Buffer.concat(
      migrationAssets.map((migration) => Buffer.from(migration.sql)),
    ),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaHead: "0003_builder_v1_binding",
        migrationSetDigest,
        migrationDigestAlgorithm:
          "sha256(concat(runtime-ordered exact migration SQL bytes))",
        migrationBindings: migrationAssets.map((migration) => ({
          id: migration.id,
          asset: migration.asset,
          runtimeModule: "dist/adapters/migrations.js",
          digest: sha256(migration.sql),
          exactBytes: true,
        })),
        packages: {
          verification: packIdentity(verificationPack),
          controlPlane: packIdentity(controlPlanePack),
        },
        cleanInstall: true,
        requiredClientMethods: [
          "createRun",
          "getRun",
          "streamRunEvents",
          "retryRun",
          "cancelRun",
          "resolveEvidence",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (temporary.startsWith(`${tmpdir()}/reef-verification-package-gate-`)) {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function pack(workspace, destination) {
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--pack-destination",
      destination,
      "--workspace",
      workspace,
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const parsed = JSON.parse(output);
  assert(
    Array.isArray(parsed) && parsed.length === 1,
    `unexpected npm pack result for ${workspace}`,
  );
  return parsed[0];
}

function packIdentity(value) {
  return {
    name: value.name,
    version: value.version,
    shasum: value.shasum,
    integrity: value.integrity,
    filename: value.filename,
  };
}

function json(path) {
  return JSON.parse(text(path));
}

function text(path) {
  return readFileSync(join(root, path), "utf8");
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: ["ignore", 2, 2] });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
