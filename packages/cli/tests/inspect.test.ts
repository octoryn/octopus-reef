/**
 * M6 (Inspect) — `reef inspect` runs octopus-inspect's static governance linter
 * over a workspace. These tests exercise the integration through the CLI's
 * resolved dependency: a committed secret is flagged and fails; a clean
 * workspace has no error findings.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, shouldFail } from "octopus-inspect";

test("reef inspect: flags a committed secret and fails the workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-inspect-"));
  writeFileSync(
    join(dir, "config.js"),
    'const key = "sk-live-abc123def456ghi789jklmnop";\n',
  );
  writeFileSync(join(dir, "clean.js"), "export const two = 1 + 1;\n");

  const report = await inspect(dir);
  assert.ok(report.fileCount >= 1);
  assert.ok(report.ruleCount >= 1);
  assert.ok(
    report.findings.some((f) => f.ruleId === "secret-in-source"),
    "a committed secret must be flagged",
  );
  assert.equal(shouldFail(report), true);
});

test("reef inspect: a clean workspace produces no error findings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reef-inspect-clean-"));
  writeFileSync(join(dir, "clean.js"), "export const two = 1 + 1;\n");

  const report = await inspect(dir);
  assert.equal(
    report.findings.filter((f) => f.severity === "error").length,
    0,
    "no error-level governance holes in a clean workspace",
  );
  assert.equal(shouldFail(report), false);
});
