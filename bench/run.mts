/**
 * Agent benchmark — the "oracle" that turns "is the worker any good?" into a number.
 *
 * For each task it: builds a throwaway workspace with a genuinely FAILING test,
 * runs Reef's own {@link AgentWorker} (governed + sandboxed) to fix it, then
 * measures two things that must agree:
 *   - ground truth  — we run the test ourselves; did it actually pass?
 *   - provability   — did the governed session independently verify?
 *
 * The worker is ours; the model is rented via a provider (Bedrock by default —
 * needs AWS_BEARER_TOKEN_BEDROCK). Run: `npm run bench`.
 *
 * Nothing here touches a repo: every workspace is a fresh temp dir, and every
 * command runs under the OS sandbox (no network, writes confined, throwaway HOME).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GovernedSession,
  SandboxExecutor,
  reefAllowlist,
} from "@octopus-reef/engine";
import { AgentWorker, BedrockProvider } from "@octopus-reef/agent";

interface Task {
  readonly id: string;
  readonly prompt: string;
  /** File tree of the starting workspace (with a bug). `test.js` must fail first. */
  readonly files: Readonly<Record<string, string>>;
}

const PKG = JSON.stringify({
  name: "bench-task",
  version: "1.0.0",
  scripts: { test: "node test.js" },
});
const assertJs = (expr: string, msg: string): string =>
  `if (!(${expr})) { console.error(${JSON.stringify("FAIL: " + msg)}); process.exit(1); }\n`;

const TASKS: readonly Task[] = [
  {
    id: "sign-bug",
    prompt:
      "The test is failing. Fix the bug in the source so the test passes.",
    files: {
      "package.json": PKG,
      "sum.js": "module.exports = (a, b) => a - b;\n", // BUG: should add
      "test.js":
        "const sum = require('./sum');\n" +
        assertJs("sum(2, 3) === 5", "sum(2,3) should be 5") +
        assertJs("sum(10, 1) === 11", "sum(10,1) should be 11") +
        "console.log('PASS');\n",
    },
  },
  {
    id: "off-by-one",
    prompt: "The test is failing. Fix the off-by-one bug so the test passes.",
    files: {
      "package.json": PKG,
      "range.js":
        "module.exports = (n) => { const a=[]; for (let i=1;i<n;i++) a.push(i); return a; };\n", // BUG: excludes n
      "test.js":
        "const range = require('./range');\n" +
        assertJs(
          "JSON.stringify(range(3)) === '[1,2,3]'",
          "range(3) should be [1,2,3]",
        ) +
        assertJs("range(1).length === 1", "range(1) should have 1 element") +
        "console.log('PASS');\n",
    },
  },
  {
    id: "implement-missing",
    prompt:
      "The test is failing because isPalindrome is not implemented. Implement it so the test passes.",
    files: {
      "package.json": PKG,
      "palindrome.js": "module.exports = (s) => false; // TODO: implement\n",
      "test.js":
        "const isPalindrome = require('./palindrome');\n" +
        assertJs(
          "isPalindrome('racecar') === true",
          "racecar is a palindrome",
        ) +
        assertJs(
          "isPalindrome('hello') === false",
          "hello is not a palindrome",
        ) +
        assertJs("isPalindrome('') === true", "empty string is a palindrome") +
        "console.log('PASS');\n",
    },
  },
  {
    id: "two-file",
    prompt:
      "The test is failing. There is a bug in the source (it may span more than one file). Fix it so the test passes.",
    files: {
      "package.json": PKG,
      "tax.js":
        "const RATE = 0.1;\nmodule.exports = (cents) => Math.round(cents * RATE);\n", // BUG: rate should be 0.2
      "total.js":
        "const tax = require('./tax');\nmodule.exports = (cents) => cents + tax(cents);\n",
      "test.js":
        "const total = require('./total');\n" +
        assertJs(
          "total(1000) === 1200",
          "total(1000) with 20% tax should be 1200",
        ) +
        "console.log('PASS');\n",
    },
  },
];

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 8, 0, 0, n++)).toISOString();
}

interface Row {
  readonly id: string;
  readonly outcome: string;
  readonly solved: boolean;
  readonly verified: boolean;
  readonly actions: number;
}

async function runTask(task: Task): Promise<Row> {
  const ws = mkdtempSync(join(tmpdir(), `bench-${task.id}-`));
  try {
    for (const [rel, content] of Object.entries(task.files)) {
      const p = join(ws, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
    }
    let actions = 0;
    const session = new GovernedSession({
      id: `bench-${task.id}`,
      task: task.prompt,
      driver: new AgentWorker({
        provider: new BedrockProvider(),
        maxTurns: 20,
      }),
      authorizer: reefAllowlist({
        commands: { node: "*", npm: ["test", "run"] },
      }),
      executor: new SandboxExecutor(ws, { timeoutMs: 20_000 }),
      now: clock(),
      onEvent: (e) => {
        if (e.kind === "action.executed" || e.kind === "action.denied")
          actions++;
      },
    });
    const { outcome } = await session.run();
    const verified = session.verify().ok;
    // Ground truth: run the test ourselves.
    let solved = false;
    try {
      execFileSync("node", ["test.js"], { cwd: ws, stdio: "pipe" });
      solved = true;
    } catch {
      solved = false;
    }
    return { id: task.id, outcome, solved, verified, actions };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) {
    console.error(
      "bench needs a model: set AWS_BEARER_TOKEN_BEDROCK (the worker is ours; the model is rented).",
    );
    process.exit(2);
  }
  console.log(
    `running ${TASKS.length} tasks with Reef's agent worker (Bedrock)…\n`,
  );
  const rows: Row[] = [];
  for (const task of TASKS) {
    process.stdout.write(`  ${task.id} … `);
    const row = await runTask(task);
    rows.push(row);
    console.log(
      `${row.solved ? "SOLVED" : "unsolved"} · ${row.verified ? "verified" : "UNVERIFIED"} · ${row.actions} actions · ${row.outcome}`,
    );
  }

  const solved = rows.filter((r) => r.solved).length;
  const verified = rows.filter((r) => r.verified).length;
  console.log("\n── scoreboard ───────────────────────────────");
  console.log("task                solved  verified  actions");
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(20)}${(r.solved ? "yes" : "no").padEnd(8)}${(r.verified ? "yes" : "no").padEnd(10)}${r.actions}`,
    );
  }
  console.log("─────────────────────────────────────────────");
  console.log(`solve rate:   ${solved}/${rows.length}`);
  console.log(
    `verifiable:   ${verified}/${rows.length} (every governed session must verify)`,
  );
  // The whole thesis: a real working agent whose every run is independently provable.
  if (verified !== rows.length) process.exit(1);
}

await main();
