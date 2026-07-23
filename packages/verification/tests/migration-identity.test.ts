import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERIFICATION_MIGRATIONS } from "../src/adapters/migrations.js";

test("runtime migration bytes exactly match the published migration asset", () => {
  const expected = [
    ["0001_verification", "0001_verification.sql"],
    ["0002_materialization", "0002_materialization.sql"],
    ["0003_builder_v1_binding", "0003_builder_v1_binding.sql"],
  ] as const;
  assert.equal(VERIFICATION_MIGRATIONS.length, expected.length);
  for (const [index, [id, filename]] of expected.entries()) {
    const asset = readFileSync(
      new URL(`../migrations/${filename}`, import.meta.url),
      "utf8",
    );
    assert.equal(VERIFICATION_MIGRATIONS[index]?.id, id);
    assert.equal(VERIFICATION_MIGRATIONS[index]?.sql, asset);
    assert.equal(
      digest(VERIFICATION_MIGRATIONS[index]?.sql ?? ""),
      digest(asset),
    );
  }
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
