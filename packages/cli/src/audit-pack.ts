import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  GovernedSession,
  MockDriver,
  UnsafeDemoDriver,
  loadSession,
  persistSession,
  replaySession,
  type ReefEvent,
  type SessionOutcome,
} from "@octopus-reef/engine";
import {
  Orchestrator,
  ledgerHead,
  verifyLedger,
  type Acceptance,
  type Planner,
  type Router,
  type Subtask,
  type Worker,
  type WorkerLedger,
  type WorkerResult,
} from "@octopus-reef/agent";

const SESSION_FILES = ["session.log.jsonl", "workstate.jsonl", "session.json"];
const MANIFEST = "manifest.json";
const MANIFEST_SHA = "manifest.sha256";

export interface AuditArtifact {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface AuditSessionSummary {
  readonly id: string;
  readonly task: string;
  readonly outcome: SessionOutcome;
  readonly workState: string | undefined;
  readonly workHead: string;
  readonly logHead: string;
  readonly workChainLength: number;
  readonly logChainLength: number;
  readonly replayEvents: number;
  readonly verified: boolean;
}

export interface AuditManifest {
  readonly version: 1;
  readonly generatedAt: string;
  readonly kind: "reef.audit-pack";
  readonly sessions: readonly AuditSessionSummary[];
  readonly workerLedger: {
    readonly path: string;
    readonly head: string;
    readonly verified: boolean;
  };
  readonly replayProof: {
    readonly path: string;
  };
  readonly controlMap: {
    readonly path: string;
    readonly note: string;
  };
  readonly artifacts: readonly AuditArtifact[];
}

export interface ExportAuditPackOptions {
  readonly sessionDirs: readonly string[];
  readonly outDir: string;
  readonly integritySecret?: string;
  readonly generatedAt?: string;
}

export interface ExportAuditPackResult {
  readonly outDir: string;
  readonly manifest: AuditManifest;
  readonly verification: AuditPackVerification;
}

export interface AuditPackVerification {
  readonly ok: boolean;
  readonly reason: string;
  readonly sessions: readonly AuditSessionSummary[];
  readonly ledgerHead?: string;
}

interface LoadedForPack {
  readonly summary: AuditSessionSummary;
  readonly workerResult: WorkerResult;
  readonly replayed: ReturnType<typeof replaySession>;
}

const CONTROL_MAP = [
  {
    control: "SOC 2 Type II audit-trail evidence",
    reefArtifact:
      "session.log.jsonl, workstate.jsonl, worker-ledger.json, replay-proof.json",
    satisfies:
      "Every action and decision is an evidence link; the work spine and evidence log are independently re-verified and cross-bound.",
  },
  {
    control: "ISO/IEC 42001 AI system logging and monitoring",
    reefArtifact: "Worker Ledger plus session evidence chain",
    satisfies:
      "The ledger records plan, route, result, and acceptance decisions with accountable worker identity and pinned session heads.",
  },
  {
    control: "EU AI Act audit-trail / logging language",
    reefArtifact: "replay-proof.json and tamper-evident session files",
    satisfies:
      "Replay reconstructs the session timeline only after store-untrusting verification; tampering any copied artifact makes verification fail.",
  },
  {
    control: "Fail-closed change control",
    reefArtifact: "action.denied evidence links",
    satisfies:
      "Dangerous or unreviewed actions are denied before execution and the denial itself is recorded as evidence.",
  },
];

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hashFile(path: string, artifactPath = path): AuditArtifact {
  const body = readFileSync(path);
  return { path: artifactPath, bytes: body.length, sha256: sha256(body) };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function stableNow(): string {
  return new Date().toISOString();
}

function safeId(dir: string, fallback: string): string {
  const name = basename(dir).replace(/[^a-zA-Z0-9_.-]/g, "-");
  return name === "" ? fallback : name;
}

function outcomeOf(events: readonly ReefEvent[]): SessionOutcome {
  const seal = [...events]
    .reverse()
    .find((event) => event.kind === "session.sealed");
  const outcome = seal?.data["outcome"];
  return outcome === "completed" ||
    outcome === "cancelled" ||
    outcome === "failed"
    ? outcome
    : "failed";
}

function sealReason(events: readonly ReefEvent[]): string {
  const seal = [...events]
    .reverse()
    .find((event) => event.kind === "session.sealed");
  const reason = seal?.data["reason"];
  return typeof reason === "string" && reason.length > 0
    ? reason
    : "loaded persisted governed session";
}

function snapshotTask(sessionDir: string, fallback: string): string {
  try {
    const meta = readJson(join(sessionDir, "session.json"));
    if (meta !== null && typeof meta === "object" && "task" in meta) {
      const task = (meta as { task?: unknown }).task;
      if (typeof task === "string" && task.trim() !== "") return task;
    }
  } catch {
    /* fall back below */
  }
  return fallback;
}

function loadForPack(
  sessionDir: string,
  id: string,
  integritySecret: string | undefined,
): LoadedForPack {
  const persistOptions =
    integritySecret !== undefined ? { integritySecret } : {};
  const loaded = loadSession(sessionDir, persistOptions);
  const replayed = replaySession(sessionDir, persistOptions);
  const task = snapshotTask(sessionDir, id);
  const outcome = outcomeOf(replayed.events);
  const workAudit = loaded.graph.exportAuditTrail();
  const record = {
    work: { evidence: workAudit.evidence, chain: workAudit.chain },
    log: {
      evidence: loaded.log.evidences(),
      chain: loaded.log.records().map((record) => record.link),
    },
  };
  const summary: AuditSessionSummary = {
    id,
    task,
    outcome,
    workState: loaded.workState,
    workHead: loaded.graph.anchor().head,
    logHead: loaded.log.head,
    workChainLength: loaded.workChainLength,
    logChainLength: loaded.logChainLength,
    replayEvents: replayed.events.length,
    verified: true,
  };
  return {
    summary,
    replayed,
    workerResult: {
      outcome,
      output: sealReason(replayed.events),
      workHead: summary.workHead,
      logHead: summary.logHead,
      verified: true,
      record,
    },
  };
}

async function buildLedger(
  task: string,
  loaded: readonly LoadedForPack[],
  generatedAt: string,
  integritySecret: string | undefined,
): Promise<{
  readonly ledger: WorkerLedger;
  readonly head: string;
  readonly verified: boolean;
  readonly accepted: Acceptance | undefined;
}> {
  const subtasks: Subtask[] = loaded.map((item) => ({
    id: item.summary.id,
    description: item.summary.task,
  }));
  let index = 0;
  const planner: Planner = {
    plan: () => Promise.resolve(subtasks),
  };
  const router: Router = {
    route: () =>
      Promise.resolve({
        worker: "audit-loader",
        reason: "package an already-governed persisted session",
      }),
  };
  const worker: Worker = {
    name: "audit-loader",
    description:
      "Loads persisted governed sessions and binds their verified heads into an audit Worker Ledger.",
    run: () => {
      const next = loaded[index++];
      if (next === undefined) throw new Error("audit-loader exhausted");
      return Promise.resolve(next.workerResult);
    },
  };
  let tick = 0;
  const orchestrator = new Orchestrator({
    workers: [worker],
    planner,
    router,
    now: () =>
      `${generatedAt.replace(/Z$/, "")}.${String(tick++).padStart(3, "0")}Z`,
    ...(integritySecret !== undefined ? { integritySecret } : {}),
    acceptance: {
      contractHash: sha256(
        JSON.stringify({
          kind: "reef.audit-pack.contract",
          sessions: loaded.map((item) => ({
            id: item.summary.id,
            logHead: item.summary.logHead,
            workHead: item.summary.workHead,
          })),
        }),
      ),
      contract: {
        kind: "reef.audit-pack.contract",
        requires: [
          "all sessions load store-untrusting",
          "all sessions replay from verified evidence",
          "all worker results pin verified work and log heads",
        ],
      },
      judge: (_task, steps) =>
        Promise.resolve({
          met: steps.every((step) => step.result.verified),
          reason:
            "all governed sessions verified and replayed before packaging",
        }),
    },
  });
  const result = await orchestrator.orchestrate(task);
  return {
    ledger: result.ledger,
    head: ledgerHead(result.ledger),
    verified: verifyLedger(result.ledger, integritySecret),
    accepted: result.accepted,
  };
}

function collectArtifacts(
  root: string,
  paths: readonly string[],
): AuditArtifact[] {
  return paths.map((path) => hashFile(join(root, path), path));
}

export async function exportAuditPack(
  options: ExportAuditPackOptions,
): Promise<ExportAuditPackResult> {
  if (options.sessionDirs.length === 0) {
    throw new Error("audit pack needs at least one session directory");
  }
  mkdirSync(options.outDir, { recursive: true });
  mkdirSync(join(options.outDir, "sessions"), { recursive: true });
  const generatedAt = options.generatedAt ?? stableNow();

  const loaded: LoadedForPack[] = [];
  const copiedPaths: string[] = [];
  for (let i = 0; i < options.sessionDirs.length; i++) {
    const source = options.sessionDirs[i]!;
    const id = safeId(source, `session-${i + 1}`);
    const item = loadForPack(source, id, options.integritySecret);
    loaded.push(item);
    const dest = join(options.outDir, "sessions", id);
    mkdirSync(dest, { recursive: true });
    for (const file of SESSION_FILES) {
      const from = join(source, file);
      const to = join(dest, file);
      copyFileSync(from, to);
      copiedPaths.push(join("sessions", id, file));
    }
  }

  const ledger = await buildLedger(
    `audit pack export for ${loaded.length} governed session(s)`,
    loaded,
    generatedAt,
    options.integritySecret,
  );
  writeJson(join(options.outDir, "worker-ledger.json"), {
    ledger: ledger.ledger,
    head: ledger.head,
    verified: ledger.verified,
    accepted: ledger.accepted ?? null,
    sessions: loaded.map((item) => ({
      id: item.summary.id,
      task: item.summary.task,
      outcome: item.summary.outcome,
      workHead: item.summary.workHead,
      logHead: item.summary.logHead,
      verified: item.summary.verified,
    })),
  });
  writeJson(join(options.outDir, "replay-proof.json"), {
    generatedAt,
    sessions: loaded.map((item) => ({
      id: item.summary.id,
      task: item.summary.task,
      outcome: item.summary.outcome,
      replayEvents: item.replayed.events.length,
      firstEvidenceId: item.replayed.events[0]?.evidenceId ?? null,
      lastEvidenceId: item.replayed.events.at(-1)?.evidenceId ?? null,
      timeline: item.replayed.events.map((event) => ({
        seq: event.seq,
        kind: event.kind,
        evidenceId: event.evidenceId,
        summary: event.summary,
      })),
    })),
  });
  writeJson(join(options.outDir, "control-map.json"), CONTROL_MAP);
  writeFileSync(
    join(options.outDir, "README.md"),
    [
      "# Reef Audit Pack",
      "",
      "This bundle is self-contained: session evidence, workstate, Worker Ledger, replay proof, and a control map are all copied into the pack.",
      "Verify it with `reef audit-verify <pack-dir>`. A one-byte change to any listed artifact or to the manifest checksum turns verification red.",
      "",
    ].join("\n"),
  );

  const artifactPaths = [
    ...copiedPaths,
    "worker-ledger.json",
    "replay-proof.json",
    "control-map.json",
    "README.md",
  ];
  const manifest: AuditManifest = {
    version: 1,
    generatedAt,
    kind: "reef.audit-pack",
    sessions: loaded.map((item) => item.summary),
    workerLedger: {
      path: "worker-ledger.json",
      head: ledger.head,
      verified: ledger.verified,
    },
    replayProof: { path: "replay-proof.json" },
    controlMap: {
      path: "control-map.json",
      note: "Control mapping aid, not legal advice; artifacts are the authoritative evidence.",
    },
    artifacts: collectArtifacts(options.outDir, artifactPaths),
  };
  const manifestPath = join(options.outDir, MANIFEST);
  writeJson(manifestPath, manifest);
  writeFileSync(
    join(options.outDir, MANIFEST_SHA),
    `${sha256(readFileSync(manifestPath))}  ${MANIFEST}\n`,
  );

  const verification = verifyAuditPack({
    packDir: options.outDir,
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
  });
  return { outDir: options.outDir, manifest, verification };
}

function fail(reason: string): AuditPackVerification {
  return { ok: false, reason, sessions: [] };
}

function readManifest(packDir: string): AuditManifest | AuditPackVerification {
  const manifestPath = join(packDir, MANIFEST);
  const shaPath = join(packDir, MANIFEST_SHA);
  if (!existsSync(manifestPath)) return fail("missing manifest.json");
  if (!existsSync(shaPath)) return fail("missing manifest.sha256");
  const manifestBytes = readFileSync(manifestPath);
  const expectedLine = `${sha256(manifestBytes)}  ${MANIFEST}\n`;
  const actualLine = readFileSync(shaPath, "utf8");
  if (actualLine !== expectedLine) {
    return fail("manifest checksum mismatch");
  }
  const parsed = JSON.parse(manifestBytes.toString("utf8")) as AuditManifest;
  if (parsed.version !== 1 || parsed.kind !== "reef.audit-pack") {
    return fail("unrecognized audit pack manifest");
  }
  return parsed;
}

export function verifyAuditPack(options: {
  readonly packDir: string;
  readonly integritySecret?: string;
}): AuditPackVerification {
  try {
    const manifestOrFailure = readManifest(options.packDir);
    if ("ok" in manifestOrFailure) return manifestOrFailure;
    const manifest = manifestOrFailure;
    for (const artifact of manifest.artifacts) {
      const full = join(options.packDir, artifact.path);
      if (!existsSync(full)) return fail(`missing artifact: ${artifact.path}`);
      const actual = hashFile(full);
      if (
        actual.bytes !== artifact.bytes ||
        actual.sha256 !== artifact.sha256
      ) {
        return fail(`artifact hash mismatch: ${artifact.path}`);
      }
    }

    const ledgerFile = readJson(
      join(options.packDir, manifest.workerLedger.path),
    ) as {
      readonly ledger?: WorkerLedger;
      readonly head?: string;
    };
    if (ledgerFile.ledger === undefined) return fail("missing worker ledger");
    const head = ledgerHead(ledgerFile.ledger);
    if (head !== manifest.workerLedger.head || head !== ledgerFile.head) {
      return fail("worker ledger head mismatch");
    }
    if (!verifyLedger(ledgerFile.ledger, options.integritySecret)) {
      return fail("worker ledger failed verification");
    }

    const replayProof = readJson(
      join(options.packDir, manifest.replayProof.path),
    ) as {
      readonly sessions?: readonly {
        readonly id?: string;
        readonly replayEvents?: number;
      }[];
    };
    const proofSessions = new Map(
      (replayProof.sessions ?? []).map((session) => [
        session.id,
        session.replayEvents,
      ]),
    );
    const verifiedSessions: AuditSessionSummary[] = [];
    for (const expected of manifest.sessions) {
      const dir = join(options.packDir, "sessions", expected.id);
      const persistOptions =
        options.integritySecret !== undefined
          ? { integritySecret: options.integritySecret }
          : {};
      const loaded = loadSession(dir, persistOptions);
      const replayed = replaySession(dir, persistOptions);
      if (loaded.graph.anchor().head !== expected.workHead) {
        return fail(`session ${expected.id} work head mismatch`);
      }
      if (loaded.log.head !== expected.logHead) {
        return fail(`session ${expected.id} log head mismatch`);
      }
      if (replayed.events.length !== proofSessions.get(expected.id)) {
        return fail(`session ${expected.id} replay proof mismatch`);
      }
      verifiedSessions.push(expected);
    }

    const controls = readJson(join(options.packDir, manifest.controlMap.path));
    if (!Array.isArray(controls) || controls.length < 3) {
      return fail("control map is missing required rows");
    }

    return {
      ok: true,
      reason: "audit pack verified store-untrusting",
      sessions: verifiedSessions,
      ledgerHead: head,
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function runMockSessionForAuditPack(options: {
  readonly task: string;
  readonly outDir: string;
  readonly integritySecret?: string;
}): Promise<string> {
  mkdirSync(options.outDir, { recursive: true });
  const session = new GovernedSession({
    id: "audit-mock-session",
    task: options.task,
    driver: new MockDriver(),
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
  });
  await session.run();
  persistSession(session, options.outDir);
  return options.outDir;
}

export interface SayNoDemoResult {
  readonly outDir: string;
  readonly sessionDir: string;
  readonly packDir: string;
  readonly denied: {
    readonly evidenceId: string;
    readonly evidenceLink: string;
    readonly reason: string;
    readonly policy: string;
  };
  readonly sessionVerified: boolean;
  readonly packVerified: boolean;
}

export async function runSayNoDemo(options: {
  readonly outDir: string;
  readonly task?: string;
  readonly integritySecret?: string;
  readonly generatedAt?: string;
}): Promise<SayNoDemoResult> {
  mkdirSync(options.outDir, { recursive: true });
  const sessionDir = join(options.outDir, "session");
  const packDir = join(options.outDir, "audit-pack");
  const task =
    options.task ??
    "attempt unreviewed dangerous production cleanup, like the Kiro incident class";
  const session = new GovernedSession({
    id: "say-no-demo",
    task,
    driver: new UnsafeDemoDriver(),
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
  });
  const result = await session.run();
  const verify = session.verify();
  persistSession(session, sessionDir);
  const denied = result.events.find((event) => event.kind === "action.denied");
  if (denied === undefined) {
    throw new Error(
      "say-NO demo did not produce an action.denied evidence link",
    );
  }
  const reason = denied.data["reason"];
  const policy = denied.data["policy"];
  const proof = {
    denied: true,
    outcome: result.outcome,
    evidenceId: denied.evidenceId,
    evidenceLink: `reef:evidence:${denied.evidenceId}`,
    reason: typeof reason === "string" ? reason : "denied",
    policy: typeof policy === "string" ? policy : "reef policy",
    verify,
    contrast:
      "The dangerous change is denied before execution and sealed as evidence; the failure is explicit instead of an unreviewed production change.",
  };
  writeJson(join(options.outDir, "say-no-proof.json"), proof);
  const pack = await exportAuditPack({
    sessionDirs: [sessionDir],
    outDir: packDir,
    ...(options.integritySecret !== undefined
      ? { integritySecret: options.integritySecret }
      : {}),
    ...(options.generatedAt !== undefined
      ? { generatedAt: options.generatedAt }
      : {}),
  });
  return {
    outDir: options.outDir,
    sessionDir,
    packDir,
    denied: {
      evidenceId: proof.evidenceId,
      evidenceLink: proof.evidenceLink,
      reason: proof.reason,
      policy: proof.policy,
    },
    sessionVerified: verify.ok,
    packVerified: pack.verification.ok,
  };
}
