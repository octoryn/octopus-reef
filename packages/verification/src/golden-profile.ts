import { defineTrustedProfile } from "./profile.js";
import type { TrustedVerificationProfile } from "./types.js";
import { assertDigest } from "./validation.js";

/**
 * Builds the reviewed first-party Golden Stack profile around one immutable
 * sandbox image. Release automation publishes the resulting exact profile as
 * an asset; deployments register that asset rather than a mutable alias.
 */
export function createGoldenStackProfile(
  sandboxImageDigest: string,
): TrustedVerificationProfile {
  assertDigest(sandboxImageDigest, "Golden Stack sandbox image digest");
  const tool = {
    name: "golden-stack-sandbox",
    version: "0.2.1",
    imageDigest: sandboxImageDigest,
  };
  const definition = (
    checkRef: string,
    argv: readonly string[],
    workingDirectory: string,
    timeoutMs: number,
    expectedArtifacts?: TrustedVerificationProfile["checks"][number]["expectedArtifacts"],
  ): TrustedVerificationProfile["checks"][number] => ({
    checkRef,
    required: true,
    argv,
    workingDirectory,
    timeoutMs,
    outputLimitBytes: 2 * 1024 * 1024,
    environment: {},
    tool,
    ...(expectedArtifacts === undefined ? {} : { expectedArtifacts }),
  });

  return defineTrustedProfile({
    ref: "verification-profile:golden-next-fastapi-postgres",
    version: "1.0.0",
    sandboxImageDigest,
    maxDurationMs: 12 * 60_000,
    maxChecks: 10,
    checks: [
      definition(
        "frontend-dependencies",
        [
          "npm",
          "ci",
          "--offline",
          "--ignore-scripts",
          "--cache",
          "/opt/npm-cache",
        ],
        "frontend",
        120_000,
      ),
      definition("frontend-tests", ["npm", "test"], "frontend", 60_000),
      definition(
        "frontend-production-build",
        ["npm", "run", "build"],
        "frontend",
        180_000,
        [
          {
            path: "frontend/.next/build-manifest.json",
            kind: "next-build-manifest",
            mediaType: "application/json",
            required: true,
            maxBytes: 1024 * 1024,
          },
        ],
      ),
      definition(
        "backend-dependencies",
        [
          "sh",
          "-c",
          "python3 -m venv .venv && .venv/bin/pip install --no-index --find-links=/opt/wheels --requirement requirements.txt",
        ],
        "backend",
        120_000,
      ),
      definition(
        "backend-tests",
        [".venv/bin/python", "-m", "pytest", "-q"],
        "backend",
        60_000,
      ),
      definition(
        "postgres-migration-repeat",
        ["backend/.venv/bin/python", "backend/scripts/migration_check.py"],
        ".",
        120_000,
        [
          {
            path: "migration-result.json",
            kind: "postgres-migration-result",
            mediaType: "application/json",
            required: true,
            maxBytes: 64 * 1024,
          },
          {
            path: "postgres.log",
            kind: "postgres-log",
            mediaType: "text/plain",
            required: false,
            maxBytes: 1024 * 1024,
          },
        ],
      ),
      definition(
        "application-health",
        ["backend/.venv/bin/python", "backend/scripts/application_health.py"],
        ".",
        120_000,
        [
          {
            path: "application-health.json",
            kind: "application-health-result",
            mediaType: "application/json",
            required: true,
            maxBytes: 64 * 1024,
          },
        ],
      ),
      definition(
        "dependency-policy",
        [
          "sh",
          "-c",
          "cd frontend && npm audit --offline --omit=dev --audit-level=high && ../backend/.venv/bin/pip check",
        ],
        ".",
        60_000,
      ),
    ],
  });
}
