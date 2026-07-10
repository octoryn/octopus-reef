import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  exportAuditPack,
  runMockSessionForAuditPack,
  runSayNoDemo,
  verifyAuditPack,
} from "../src/audit-pack.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), name));
}

function flipOneByte(path: string, needle: string): void {
  const raw = readFileSync(path);
  const offset = raw.indexOf(Buffer.from(needle));
  assert.ok(offset >= 0, `${path} should contain ${needle}`);
  raw[offset] = raw[offset] === 0x61 ? 0x62 : 0x61;
  writeFileSync(path, raw);
}

test("audit pack exports evidence, Worker Ledger, replay proof, and control mapping", async () => {
  const sessionDir = tmp("reef-audit-session-");
  await runMockSessionForAuditPack({
    task: "prepare an audit-ready governed change",
    outDir: sessionDir,
  });
  const packDir = tmp("reef-audit-pack-");

  const exported = await exportAuditPack({
    sessionDirs: [sessionDir],
    outDir: packDir,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  assert.equal(exported.verification.ok, true);
  assert.equal(verifyAuditPack({ packDir }).ok, true);
  assert.ok(
    exported.manifest.artifacts.some((artifact) =>
      artifact.path.endsWith("session.log.jsonl"),
    ),
    "session evidence log is in the pack",
  );
  assert.ok(
    exported.manifest.artifacts.some((artifact) =>
      artifact.path.endsWith("worker-ledger.json"),
    ),
    "Worker Ledger is in the pack",
  );
  const controlMap = readFileSync(join(packDir, "control-map.json"), "utf8");
  assert.match(controlMap, /SOC 2 Type II/);
  assert.match(controlMap, /ISO\/IEC 42001/);
  assert.match(controlMap, /EU AI Act/);
});

test("audit pack verification turns red after one-byte artifact tamper", async () => {
  const sessionDir = tmp("reef-audit-session-red-");
  await runMockSessionForAuditPack({
    task: "prove tamper red",
    outDir: sessionDir,
  });
  const packDir = tmp("reef-audit-pack-red-");
  await exportAuditPack({
    sessionDirs: [sessionDir],
    outDir: packDir,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  flipOneByte(
    join(packDir, "sessions", basename(sessionDir), "session.log.jsonl"),
    "prove",
  );
  const result = verifyAuditPack({ packDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /artifact hash mismatch|failed/i);
});

test("audit pack verification turns red after Worker Ledger tamper", async () => {
  const sessionDir = tmp("reef-audit-session-ledger-");
  await runMockSessionForAuditPack({
    task: "prove ledger tamper red",
    outDir: sessionDir,
  });
  const packDir = tmp("reef-audit-pack-ledger-");
  await exportAuditPack({
    sessionDirs: [sessionDir],
    outDir: packDir,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  flipOneByte(join(packDir, "worker-ledger.json"), "audit-loader");
  const result = verifyAuditPack({ packDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /artifact hash mismatch|ledger/i);
});

test("audit pack verification turns red after manifest tamper", async () => {
  const sessionDir = tmp("reef-audit-session-manifest-");
  await runMockSessionForAuditPack({
    task: "prove manifest tamper red",
    outDir: sessionDir,
  });
  const packDir = tmp("reef-audit-pack-manifest-");
  await exportAuditPack({
    sessionDirs: [sessionDir],
    outDir: packDir,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });

  flipOneByte(join(packDir, "manifest.json"), "reef.audit-pack");
  const result = verifyAuditPack({ packDir });
  assert.equal(result.ok, false);
  assert.match(result.reason, /manifest checksum mismatch/);
});

test("say-NO demo denies a dangerous required action with an evidence link", async () => {
  const outDir = tmp("reef-say-no-");
  const result = await runSayNoDemo({
    outDir,
    generatedAt: "2026-07-10T00:00:00.000Z",
  });
  assert.equal(result.sessionVerified, true);
  assert.equal(result.packVerified, true);
  assert.match(result.denied.evidenceId, /^ev_[0-9a-f]{64}$/);
  assert.equal(
    result.denied.evidenceLink,
    `reef:evidence:${result.denied.evidenceId}`,
  );
  assert.match(result.denied.reason, /blocked|prohibited/i);
  assert.equal(verifyAuditPack({ packDir: result.packDir }).ok, true);
});
