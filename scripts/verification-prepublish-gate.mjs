#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const controlPlane = json("packages/control-plane/package.json");
const verification = json("packages/verification/package.json");

assert(
  controlPlane.name === "@octopus-reef/control-plane",
  "control-plane package identity drifted",
);
assert(
  controlPlane.version === "0.2.0",
  "control-plane release must be exactly 0.2.0",
);
assert(
  verification.name === "@octopus-reef/verification",
  "verification package identity drifted",
);
assert(
  verification.version === "0.2.0",
  "verification release must be exactly 0.2.0",
);
assert(
  controlPlane.dependencies?.["@octopus-reef/verification"] === "0.2.0",
  "control-plane must declare the exact formal verification compatibility version",
);

for (const subpath of [
  "./verification",
  "./verification/client",
  "./verification/production",
  "./verification/adapters/postgres",
  "./verification/adapters/local",
  "./verification/adapters/aws",
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

const workflow = text(".github/workflows/verification-release.yml");
for (const marker of [
  "npm publish --provenance",
  "linux/amd64,linux/arm64",
  "anchore/sbom-action",
  "aquasecurity/trivy-action@v0.32.0",
  "attest-build-provenance",
  "verification-release-record.json",
  "REEF_TEST_DOCKER_IMAGE",
  "docker compose",
  "PROFILE_REPOSITORY",
  "golden-profile.json",
  "npm rebuild better-sqlite3",
])
  assert(workflow.includes(marker), `release workflow omits ${marker}`);

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
    controlPlanePack.files.some(
      (file) => file.path === "dist/verification-client.js",
    ),
    "control-plane tarball is missing its verification client compatibility export",
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
      ].join("\n"),
    ],
    temporary,
  );

  const migrationSetDigest = sha256(
    text("packages/verification/migrations/0001_verification.sql"),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaHead: "0001_verification",
        migrationSetDigest,
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
