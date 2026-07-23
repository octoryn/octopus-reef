import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VERIFICATION_MIGRATIONS } from "../src/adapters/migrations.js";

test("runtime migration bytes exactly match the published migration asset", () => {
  const asset = readFileSync(
    new URL("../migrations/0001_verification.sql", import.meta.url),
    "utf8",
  );
  assert.equal(VERIFICATION_MIGRATIONS.length, 1);
  assert.equal(VERIFICATION_MIGRATIONS[0]?.id, "0001_verification");
  assert.equal(VERIFICATION_MIGRATIONS[0]?.sql, asset);
  assert.equal(digest(VERIFICATION_MIGRATIONS[0]?.sql ?? ""), digest(asset));
});

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
