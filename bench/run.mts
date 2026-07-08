/**
 * Agent benchmark runner — turns "is the worker good enough?" into a scoreboard.
 *
 * For each task it builds a throwaway workspace with a genuinely-failing VISIBLE
 * test the agent iterates on, runs Reef's own {@link AgentWorker} (governed +
 * sandboxed) to fix it, then scores with a HELD-OUT grader (extra cases, never
 * placed in the workspace) so a pass can't be faked by over-fitting or editing
 * the test. Two things are reported per task and must agree with the thesis:
 *   - solved     — did the held-out grader pass? (ground truth of capability)
 *   - verifiable — did the governed session independently verify? (must be 100%)
 *
 * The worker is ours; the model is rented (Bedrock; needs AWS_BEARER_TOKEN_BEDROCK).
 * Run: `npm run bench`  ·  attempts per task: BENCH_ATTEMPTS (default 1, pass@k).
 * Nothing touches a repo — every workspace is a fresh temp dir under the OS sandbox.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  GovernedSession,
  SandboxExecutor,
  reefAllowlist,
} from "@octopus-reef/engine";
import { AgentWorker, BedrockProvider } from "@octopus-reef/agent";
import { TASKS, type Task, type Tier } from "./tasks.mjs";

const ATTEMPTS = Math.max(1, Number(process.env.BENCH_ATTEMPTS ?? "1") || 1);

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 8, 0, 0, n++)).toISOString();
}

function writeFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

/** Run the held-out grader against the agent's (possibly fixed) workspace. */
function graded(ws: string, grade: string): boolean {
  writeFileSync(join(ws, "__grade__.cjs"), grade);
  try {
    execFileSync("node", ["__grade__.cjs"], { cwd: ws, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface Attempt {
  readonly solved: boolean;
  readonly verified: boolean;
  readonly actions: number;
  readonly outcome: string;
}

async function attempt(task: Task): Promise<Attempt> {
  const ws = mkdtempSync(join(tmpdir(), `bench-${task.id}-`));
  try {
    writeFiles(ws, task.files);
    let actions = 0;
    const session = new GovernedSession({
      id: `bench-${task.id}`,
      task: task.prompt,
      driver: new AgentWorker({
        provider: new BedrockProvider(),
        maxTurns: 30,
      }),
      authorizer: reefAllowlist({
        commands: { node: "*", npm: ["test", "run"] },
      }),
      executor: new SandboxExecutor(ws, { timeoutMs: 25_000 }),
      now: clock(),
      onEvent: (e) => {
        if (e.kind === "action.executed" || e.kind === "action.denied")
          actions++;
      },
    });
    const { outcome } = await session.run();
    const verified = session.verify().ok;
    const solved = graded(ws, task.grade); // held-out grading = ground truth
    return { solved, verified, actions, outcome };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

interface Row {
  readonly id: string;
  readonly tier: Tier;
  readonly solved: boolean;
  readonly verified: boolean;
  readonly actions: number;
  readonly attemptsUsed: number;
}

async function runTask(task: Task): Promise<Row> {
  let verified = true;
  let actions = 0;
  for (let i = 1; i <= ATTEMPTS; i++) {
    const a = await attempt(task);
    verified = verified && a.verified;
    actions = a.actions;
    if (a.solved)
      return {
        id: task.id,
        tier: task.tier,
        solved: true,
        verified,
        actions,
        attemptsUsed: i,
      };
  }
  return {
    id: task.id,
    tier: task.tier,
    solved: false,
    verified,
    actions,
    attemptsUsed: ATTEMPTS,
  };
}

async function main(): Promise<void> {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    console.error(
      "bench needs a model: set AWS_BEARER_TOKEN_BEDROCK (worker is ours; model is rented).",
    );
    process.exit(2);
  }
  console.log(
    `agent benchmark · ${TASKS.length} tasks · pass@${ATTEMPTS} · Reef worker (Bedrock)\n`,
  );
  const rows: Row[] = [];
  for (const task of TASKS) {
    process.stdout.write(`  ${task.id.padEnd(16)} [${task.tier}] … `);
    const row = await runTask(task);
    rows.push(row);
    console.log(
      `${row.solved ? "SOLVED" : "unsolved"} (try ${row.attemptsUsed}) · ${row.verified ? "verified" : "UNVERIFIED"} · ${row.actions} actions`,
    );
  }

  const tiers: Tier[] = ["easy", "medium", "hard"];
  const rate = (rs: Row[]): string =>
    rs.length ? `${rs.filter((r) => r.solved).length}/${rs.length}` : "–";
  console.log("\n── scoreboard ──────────────────────────────────────");
  console.log("task              tier     solved  verifiable  actions");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(18)}${r.tier.padEnd(9)}${(r.solved ? "yes" : "NO").padEnd(8)}${(r.verified ? "yes" : "NO").padEnd(12)}${r.actions}`,
    );
  }
  console.log("────────────────────────────────────────────────────");
  for (const t of tiers) {
    const rs = rows.filter((r) => r.tier === t);
    if (rs.length) console.log(`  ${t.padEnd(8)} solved  ${rate(rs)}`);
  }
  console.log(`  OVERALL  solved  ${rate(rows)}  (pass@${ATTEMPTS})`);
  console.log(
    `           verifiable  ${rows.filter((r) => r.verified).length}/${rows.length}  (every governed session must verify)`,
  );
  if (rows.some((r) => !r.verified)) process.exit(1);
}

await main();
