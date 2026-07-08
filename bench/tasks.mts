/**
 * Benchmark tasks — SWE-bench-STYLE (self-contained, no network/deps so they run
 * under the OS sandbox). Each task is a small codebase with a REAL bug and a
 * VISIBLE failing test the agent iterates on. Grading is HELD OUT: a separate
 * grader (never placed in the agent's workspace) with EXTRA cases decides
 * `solved`, so the agent cannot pass by over-fitting or editing the visible test.
 *
 * The literal SWE-bench (GitHub issues over Django/sympy/… in Docker) can't run
 * here; these tasks target the same skill — localise a bug in unfamiliar code and
 * fix it so a held-out suite passes — across easy/medium/hard tiers.
 */
export type Tier = "easy" | "medium" | "hard";

export interface Task {
  readonly id: string;
  readonly tier: Tier;
  readonly prompt: string;
  /** Files the agent starts with (buggy source + package.json + visible test). */
  readonly files: Readonly<Record<string, string>>;
  /** Held-out grader (CommonJS) run AFTER the agent; exit 0 = solved. Never shown. */
  readonly grade: string;
}

const PKG = JSON.stringify({
  name: "task",
  version: "1.0.0",
  scripts: { test: "node test.js" },
});

const PROMPT =
  "The test suite (test.js) is failing because of a bug in the source. " +
  "Read the code, find the bug, and fix the SOURCE so `npm test` passes. " +
  "Do not modify the tests.";

export const TASKS: readonly Task[] = [
  // ── easy: single-file logic bug ──────────────────────────────────────────
  {
    id: "sign-bug",
    tier: "easy",
    prompt: PROMPT,
    files: {
      "package.json": PKG,
      "sum.js": "module.exports = (a, b) => a - b;\n", // BUG: should add
      "test.js":
        "const sum = require('./sum');\n" +
        "if (sum(2, 3) !== 5) { console.error('FAIL sum(2,3)'); process.exit(1); }\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const sum = require('./sum');\n" +
      "for (const [a,b,e] of [[2,3,5],[0,0,0],[-1,1,0],[100,23,123]]) " +
      "if (sum(a,b)!==e){console.error('grade fail',a,b);process.exit(1);}\n",
  },

  // ── medium: LRU cache — recency-on-get bug ───────────────────────────────
  {
    id: "lru-cache",
    tier: "medium",
    prompt: PROMPT,
    files: {
      "package.json": PKG,
      "lru.js":
        "class LRU {\n" +
        "  constructor(capacity) { this.cap = capacity; this.map = new Map(); }\n" +
        "  get(key) {\n" +
        "    // BUG: a get must mark the key most-recently-used, but this just reads it.\n" +
        "    return this.map.has(key) ? this.map.get(key) : undefined;\n" +
        "  }\n" +
        "  put(key, value) {\n" +
        "    if (this.map.has(key)) this.map.delete(key);\n" +
        "    this.map.set(key, value);\n" +
        "    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value);\n" +
        "  }\n" +
        "}\n" +
        "module.exports = LRU;\n",
      "test.js":
        "const LRU = require('./lru');\n" +
        "const c = new LRU(2);\n" +
        "c.put(1,1); c.put(2,2); c.get(1); c.put(3,3);\n" + // get(1) → evict 2, not 1
        "if (c.get(1) !== 1) { console.error('FAIL: 1 should survive'); process.exit(1); }\n" +
        "if (c.get(2) !== undefined) { console.error('FAIL: 2 should be evicted'); process.exit(1); }\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const LRU = require('./lru');\n" +
      "const c = new LRU(2);\n" +
      "c.put('a',1); c.put('b',2); if(c.get('a')!==1){process.exit(1);} c.put('c',3);\n" +
      "if(c.get('b')!==undefined||c.get('a')!==1||c.get('c')!==3)process.exit(1);\n" +
      // updating an existing key also refreshes recency
      "const d=new LRU(2); d.put(1,1); d.put(2,2); d.put(1,10); d.put(3,3);\n" +
      "if(d.get(2)!==undefined||d.get(1)!==10||d.get(3)!==3)process.exit(1);\n",
  },

  // ── medium: merge intervals — touching-interval boundary bug ─────────────
  {
    id: "interval-merge",
    tier: "medium",
    prompt: PROMPT,
    files: {
      "package.json": PKG,
      "merge.js":
        "module.exports = (intervals) => {\n" +
        "  const s = [...intervals].sort((a, b) => a[0] - b[0]);\n" +
        "  const out = [];\n" +
        "  for (const [lo, hi] of s) {\n" +
        "    const last = out[out.length - 1];\n" +
        "    // BUG: touching intervals ([1,2] and [2,3]) should merge.\n" +
        "    if (last && lo < last[1]) last[1] = Math.max(last[1], hi);\n" +
        "    else out.push([lo, hi]);\n" +
        "  }\n" +
        "  return out;\n" +
        "};\n",
      "test.js":
        "const merge = require('./merge');\n" +
        "const eq = (a,b) => JSON.stringify(a)===JSON.stringify(b);\n" +
        "if (!eq(merge([[1,2],[2,3]]), [[1,3]])) { console.error('FAIL touching'); process.exit(1); }\n" +
        "if (!eq(merge([[1,3],[2,6],[8,10]]), [[1,6],[8,10]])) { console.error('FAIL overlap'); process.exit(1); }\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const merge = require('./merge');\n" +
      "const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);\n" +
      "if(!eq(merge([[8,10],[1,3],[2,6]]),[[1,6],[8,10]]))process.exit(1);\n" + // unsorted
      "if(!eq(merge([[1,10],[2,3]]),[[1,10]]))process.exit(1);\n" + // contained
      "if(!eq(merge([[1,2],[3,4]]),[[1,2],[3,4]]))process.exit(1);\n" + // disjoint
      "if(!eq(merge([[1,4],[4,4]]),[[1,4]]))process.exit(1);\n", // point touching
  },

  // ── medium: CSV field parser — quoted-field bug ──────────────────────────
  {
    id: "csv-parse",
    tier: "medium",
    prompt: PROMPT,
    files: {
      "package.json": PKG,
      "csv.js":
        "// Parse one CSV line into fields. Quoted fields may contain commas;\n" +
        '// a doubled quote ("") inside a quoted field is a literal quote.\n' +
        "module.exports = (line) => {\n" +
        "  // BUG: this ignores quoting entirely.\n" +
        "  return line.split(',');\n" +
        "};\n",
      "test.js":
        "const parse = require('./csv');\n" +
        "const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);\n" +
        "if(!eq(parse('a,\"b,c\",d'), ['a','b,c','d'])){console.error('FAIL quoted comma');process.exit(1);}\n" +
        "if(!eq(parse('x,y,z'), ['x','y','z'])){console.error('FAIL plain');process.exit(1);}\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const parse = require('./csv');\n" +
      "const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);\n" +
      "if(!eq(parse('a,\"b\"\"c\",d'),['a','b\"c','d']))process.exit(1);\n" + // escaped quote
      "if(!eq(parse('a,,c'),['a','','c']))process.exit(1);\n" + // empty field
      "if(!eq(parse('\"\",\"x\"'),['','x']))process.exit(1);\n" + // quoted empty
      "if(!eq(parse('one'),['one']))process.exit(1);\n",
  },

  // ── medium/hard: token-bucket limiter — missing capacity cap ─────────────
  {
    id: "token-bucket",
    tier: "medium",
    prompt: PROMPT,
    files: {
      "package.json": PKG,
      "bucket.js":
        "// A token-bucket rate limiter. `allow(now)` refills based on elapsed ms\n" +
        "// (rate = tokens/second), spends one token, and returns whether it was allowed.\n" +
        "class Bucket {\n" +
        "  constructor(capacity, ratePerSec) {\n" +
        "    this.cap = capacity; this.rate = ratePerSec; this.tokens = capacity; this.last = 0;\n" +
        "  }\n" +
        "  allow(now) {\n" +
        "    const elapsed = (now - this.last) / 1000;\n" +
        "    // BUG: refilled tokens must be capped at capacity.\n" +
        "    this.tokens = this.tokens + elapsed * this.rate;\n" +
        "    this.last = now;\n" +
        "    if (this.tokens >= 1) { this.tokens -= 1; return true; }\n" +
        "    return false;\n" +
        "  }\n" +
        "}\n" +
        "module.exports = Bucket;\n",
      "test.js":
        "const Bucket = require('./bucket');\n" +
        "const b = new Bucket(2, 1);\n" +
        "// spend the 2 starting tokens at t=0\n" +
        "if(!b.allow(0)||!b.allow(0)||b.allow(0)){console.error('FAIL initial');process.exit(1);}\n" +
        "// idle 100s: refill must cap at 2, so only 2 more allowed\n" +
        "let ok=0; for(let i=0;i<5;i++) if(b.allow(100000)) ok++;\n" +
        "if(ok!==2){console.error('FAIL cap, got '+ok);process.exit(1);}\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const Bucket = require('./bucket');\n" +
      "let b=new Bucket(3,2);\n" +
      "if(!b.allow(0)||!b.allow(0)||!b.allow(0)||b.allow(0))process.exit(1);\n" + // cap 3
      "if(!b.allow(500))process.exit(1);\n" + // 0.5s * 2 = 1 token
      "if(b.allow(500))process.exit(1);\n" + // none left
      "let c=new Bucket(2,1),n=0; for(let i=0;i<10;i++) if(c.allow(1000000)) n++;\n" +
      "if(n!==2)process.exit(1);\n",
  },

  // ── hard: multi-file arithmetic evaluator — operator-precedence bug ───────
  {
    id: "expr-eval",
    tier: "hard",
    prompt:
      "This little arithmetic evaluator (index.js → tokenize.js, parse.js, eval.js) " +
      "computes the wrong answer for expressions that mix + / - with * / /. " +
      "The test suite (test.js) is failing. Find and fix the bug in the SOURCE so " +
      "`npm test` passes. Do not modify the tests.",
    files: {
      "package.json": PKG,
      "tokenize.js":
        "module.exports = (s) => s.match(/\\d+(?:\\.\\d+)?|[()+\\-*/]/g) || [];\n",
      "parse.js":
        "// Shunting-yard: tokens -> RPN (reverse Polish) output queue.\n" +
        "// BUG: the precedence table is wrong — * and / must bind tighter than + and -.\n" +
        "const PREC = { '+': 1, '-': 1, '*': 1, '/': 1 };\n" +
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
      "eval.js":
        "module.exports = (rpn) => {\n" +
        "  const st = [];\n" +
        "  for (const t of rpn) {\n" +
        "    if (/^\\d/.test(t)) { st.push(parseFloat(t)); continue; }\n" +
        "    const b = st.pop(), a = st.pop();\n" +
        "    st.push(t === '+' ? a+b : t === '-' ? a-b : t === '*' ? a*b : a/b);\n" +
        "  }\n" +
        "  return st[0];\n" +
        "};\n",
      "index.js":
        "const tokenize = require('./tokenize'), parse = require('./parse'), evaluate = require('./eval');\n" +
        "module.exports = (s) => evaluate(parse(tokenize(s)));\n",
      "test.js":
        "const calc = require('./index');\n" +
        "if (calc('2+3*4') !== 14) { console.error('FAIL 2+3*4 =', calc('2+3*4')); process.exit(1); }\n" +
        "if (calc('2*3+4') !== 10) { console.error('FAIL 2*3+4'); process.exit(1); }\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const calc = require('./index');\n" +
      "const cases = [['2+3*4',14],['(2+3)*4',20],['10-2-3',5],['8/2/2',2],['1+2*3-4',3],['2*3*4',24],['10-2*3',4]];\n" +
      "for (const [e,v] of cases) if (Math.abs(calc(e)-v) > 1e-9) { console.error('grade fail',e,calc(e)); process.exit(1); }\n",
  },

  // ── hard: min-coins — greedy is wrong, needs DP ──────────────────────────
  {
    id: "coin-change",
    tier: "hard",
    prompt:
      "minCoins(coins, amount) must return the FEWEST coins that sum to amount " +
      "(or -1 if impossible). It is failing some tests because the current approach " +
      "is not always optimal. Fix the SOURCE so `npm test` passes. Do not modify the tests.",
    files: {
      "package.json": PKG,
      "coins.js":
        "// Fewest coins to make `amount`, or -1 if impossible.\n" +
        "// BUG: a greedy largest-first strategy is not optimal for all coin sets.\n" +
        "module.exports = (coins, amount) => {\n" +
        "  const sorted = [...coins].sort((a, b) => b - a);\n" +
        "  let left = amount, count = 0;\n" +
        "  for (const c of sorted) { while (left >= c) { left -= c; count++; } }\n" +
        "  return left === 0 ? count : -1;\n" +
        "};\n",
      "test.js":
        "const minCoins = require('./coins');\n" +
        "if (minCoins([1,3,4], 6) !== 2) { console.error('FAIL [1,3,4],6 =', minCoins([1,3,4],6)); process.exit(1); }\n" +
        "if (minCoins([1,2,5], 11) !== 3) { console.error('FAIL [1,2,5],11'); process.exit(1); }\n" +
        "console.log('PASS');\n",
    },
    grade:
      "const minCoins = require('./coins');\n" +
      "const cases = [[[1,3,4],6,2],[[1,2,5],11,3],[[2],3,-1],[[1,2,5],0,0],[[186,419,83,408],6249,20],[[3,7],5,-1],[[1],7,7]];\n" +
      "for (const [c,a,e] of cases) if (minCoins(c,a)!==e) { console.error('grade fail',c,a,minCoins(c,a),'!=',e); process.exit(1); }\n",
  },
];
