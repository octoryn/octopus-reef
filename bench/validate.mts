/**
 * Benchmark soundness check — proves every task is well-formed BEFORE we let the
 * agent near it, so the scoreboard measures the agent and not a broken grader.
 *
 * For each task it asserts, with a known-correct reference fix:
 *   1. the buggy source actually FAILS the visible test (there is a real bug), and
 *   2. the reference fix PASSES both the visible test AND the held-out grader.
 *
 * The `FIXES` below are the reference solutions (the answer key). Run offline,
 * no model, no network: `tsx bench/validate.mjs`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TASKS } from "./tasks.mjs";

/** Reference fixes (answer key): taskId → { filename → corrected content }. */
const FIXES: Record<string, Record<string, string>> = {
  "sign-bug": { "sum.js": "module.exports = (a, b) => a + b;\n" },
  "lru-cache": {
    "lru.js":
      "class LRU {\n" +
      "  constructor(capacity) { this.cap = capacity; this.map = new Map(); }\n" +
      "  get(key) {\n" +
      "    if (!this.map.has(key)) return undefined;\n" +
      "    const v = this.map.get(key);\n" +
      "    this.map.delete(key); this.map.set(key, v);\n" +
      "    return v;\n" +
      "  }\n" +
      "  put(key, value) {\n" +
      "    if (this.map.has(key)) this.map.delete(key);\n" +
      "    this.map.set(key, value);\n" +
      "    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);\n" +
      "  }\n" +
      "}\n" +
      "module.exports = LRU;\n",
  },
  "interval-merge": {
    "merge.js":
      "module.exports = (intervals) => {\n" +
      "  const s = [...intervals].sort((a, b) => a[0] - b[0]);\n" +
      "  const out = [];\n" +
      "  for (const [lo, hi] of s) {\n" +
      "    const last = out[out.length - 1];\n" +
      "    if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);\n" +
      "    else out.push([lo, hi]);\n" +
      "  }\n" +
      "  return out;\n" +
      "};\n",
  },
  "csv-parse": {
    "csv.js":
      "module.exports = (line) => {\n" +
      "  const out = []; let cur = ''; let q = false;\n" +
      "  for (let i = 0; i < line.length; i++) {\n" +
      "    const c = line[i];\n" +
      "    if (q) {\n" +
      "      if (c === '\"') { if (line[i+1] === '\"') { cur += '\"'; i++; } else q = false; }\n" +
      "      else cur += c;\n" +
      "    } else if (c === '\"') q = true;\n" +
      "    else if (c === ',') { out.push(cur); cur = ''; }\n" +
      "    else cur += c;\n" +
      "  }\n" +
      "  out.push(cur); return out;\n" +
      "};\n",
  },
  "token-bucket": {
    "bucket.js":
      "class Bucket {\n" +
      "  constructor(capacity, ratePerSec) {\n" +
      "    this.cap = capacity; this.rate = ratePerSec; this.tokens = capacity; this.last = 0;\n" +
      "  }\n" +
      "  allow(now) {\n" +
      "    const elapsed = (now - this.last) / 1000;\n" +
      "    this.tokens = Math.min(this.cap, this.tokens + elapsed * this.rate);\n" +
      "    this.last = now;\n" +
      "    if (this.tokens >= 1) { this.tokens -= 1; return true; }\n" +
      "    return false;\n" +
      "  }\n" +
      "}\n" +
      "module.exports = Bucket;\n",
  },
  "expr-eval": {
    "parse.js":
      "const PREC = { '+': 1, '-': 1, '*': 2, '/': 2 };\n" +
      "module.exports = (tokens) => {\n" +
      "  const out = [], ops = [];\n" +
      "  for (const t of tokens) {\n" +
      "    if (/^\\d/.test(t)) out.push(t);\n" +
      "    else if (t === '(') ops.push(t);\n" +
      "    else if (t === ')') { while (ops.length && ops[ops.length-1] !== '(') out.push(ops.pop()); ops.pop(); }\n" +
      "    else { while (ops.length && ops[ops.length-1] !== '(' && PREC[ops[ops.length-1]] >= PREC[t]) out.push(ops.pop()); ops.push(t); }\n" +
      "  }\n" +
      "  while (ops.length) out.push(ops.pop());\n" +
      "  return out;\n" +
      "};\n",
  },
  "coin-change": {
    "coins.js":
      "module.exports = (coins, amount) => {\n" +
      "  const dp = new Array(amount + 1).fill(Infinity);\n" +
      "  dp[0] = 0;\n" +
      "  for (let a = 1; a <= amount; a++)\n" +
      "    for (const c of coins) if (c <= a && dp[a - c] + 1 < dp[a]) dp[a] = dp[a - c] + 1;\n" +
      "  return dp[amount] === Infinity ? -1 : dp[amount];\n" +
      "};\n",
  },
};

function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

function passes(ws: string, script: string, name: string): boolean {
  writeFileSync(join(ws, name), script);
  try {
    execFileSync("node", [name], { cwd: ws, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
for (const task of TASKS) {
  const fix = FIXES[task.id];
  if (!fix) {
    console.error(`✗ ${task.id}: no reference fix`);
    failures++;
    continue;
  }
  // 1. buggy → visible test must FAIL
  const buggy = mkdtempSync(join(tmpdir(), `val-${task.id}-`));
  const testScript = task.files["test.js"]!;
  write(buggy, task.files);
  const buggyPasses = passes(buggy, testScript, "run-test.cjs");
  rmSync(buggy, { recursive: true, force: true });

  // 2. fixed → visible test AND held-out grade must PASS
  const fixed = mkdtempSync(join(tmpdir(), `val-${task.id}-`));
  write(fixed, task.files);
  write(fixed, fix);
  const testOk = passes(fixed, testScript, "run-test.cjs");
  const gradeOk = passes(fixed, task.grade, "run-grade.cjs");
  rmSync(fixed, { recursive: true, force: true });

  const ok = !buggyPasses && testOk && gradeOk;
  if (ok) console.log(`✓ ${task.id}`);
  else {
    failures++;
    console.error(
      `✗ ${task.id}: buggy-fails=${!buggyPasses} fix-passes-test=${testOk} fix-passes-grade=${gradeOk}`,
    );
  }
}

console.log(`\n${TASKS.length - failures}/${TASKS.length} tasks well-formed`);
if (failures > 0) process.exit(1);
