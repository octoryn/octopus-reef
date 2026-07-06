import assert from "node:assert/strict";
import { test } from "node:test";
import { EvidenceLog, type LogRecord } from "../src/index.js";

function at(n: number): string {
  return new Date(Date.UTC(2026, 6, 6, 0, 0, n)).toISOString();
}

function sampleInput(i: number) {
  return {
    kind: "reef.test",
    subject: [{ type: "work-item", id: "w1" }],
    content: { i, note: `event ${i}` },
    provenance: { source: "reef", method: "test", at: at(i) },
  } as const;
}

test("an evidence log appends and verifies", () => {
  const log = new EvidenceLog();
  for (let i = 0; i < 6; i++) log.append(sampleInput(i));
  assert.equal(log.length, 6);
  assert.equal(log.verify().ok, true);
});

test("verify catches a mutated evidence body", () => {
  const log = new EvidenceLog();
  for (let i = 0; i < 4; i++) log.append(sampleInput(i));
  const records = log.records();
  // Mutate the stored content of record 2, keeping its (now stale) hashes.
  (
    records[2] as { evidence: { content: { note: string } } }
  ).evidence.content.note = "tampered";
  const check = EvidenceLog.restore.bind(null, records);
  assert.throws(check, /cannot restore/);
});

test("verify catches a reordered chain", () => {
  const log = new EvidenceLog();
  for (let i = 0; i < 4; i++) log.append(sampleInput(i));
  const records = log.records();
  const swapped: LogRecord[] = [
    records[0]!,
    records[2]!,
    records[1]!,
    records[3]!,
  ];
  assert.throws(() => EvidenceLog.restore(swapped), /cannot restore/);
});

test("expectedLength / expectedHead catch truncation", () => {
  const log = new EvidenceLog();
  for (let i = 0; i < 5; i++) log.append(sampleInput(i));
  const fullHead = log.head;
  const fullLen = log.length;

  const truncated = EvidenceLog.restore(log.records().slice(0, 4));
  const check = truncated.verify({
    expectedLength: fullLen,
    expectedHead: fullHead,
  });
  assert.equal(check.ok, false);
});

test("keyed logs need the key to verify", () => {
  const log = new EvidenceLog({ integritySecret: "k" });
  for (let i = 0; i < 3; i++) log.append(sampleInput(i));
  assert.equal(log.verify().ok, true);
  // Restoring the same records without the key must fail integrity.
  assert.throws(() => EvidenceLog.restore(log.records()), /cannot restore/);
});
