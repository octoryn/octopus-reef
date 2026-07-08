**English** | [简体中文](CONDUCTOR.zh-CN.md)

# The Conductor — prove what the *fleet* did

The engine ([ARCHITECTURE.md](ARCHITECTURE.md)) proves **one** agent's session.
The conductor (`@octopus-reef/agent`) proves a **fleet** of them.

It is not another coding agent, and it does not compete with Claude Code, Codex,
or Gemini. It sits **above** them: a governed dispatcher that translates intent
into subtasks, routes each to the best available worker, runs every worker under
governance, and — the part that matters — **proves what the whole fleet did**.

> Routing is commodity (AutoGen, CrewAI, LangGraph all route). The moat is
> **provable** orchestration: a tamper-evident ledger that pins each sub-session,
> plus acceptance that is a real machine-check. That is what this package adds.

## The one idea

```
task ─▶ Orchestrator
         │
         ├─ Planner ───────▶ subtasks
         │
         ├─ for each subtask:
         │     Router ─────▶ pick a Worker
         │     Worker.run ─▶ a governed sub-session (its own two chains)
         │                    └─ returns a WorkerResult that PINS the sub-session heads
         │
         ├─ Acceptance (optional) ─▶ judge the results against a contract
         │
         └─ Worker Ledger ─▶ octopus-evidence chain of the whole run
                 plan → contract → route → result → … → acceptance → done
```

Every arrow above is minted as `octopus-evidence`. The **Worker Ledger** is a
single tamper-evident chain over the orchestration itself; each `result` entry
records the head of the sub-session it came from. Swap a sub-session for another
and the pinned head no longer matches; change one byte of any entry and
`verifyLedger` goes red.

## The seams

The conductor is a set of small interfaces so every part is swappable and
testable offline.

| Seam | Job | Ships with |
|---|---|---|
| `Planner` | task → subtasks | `LlmPlanner` (any provider) or your own |
| `Router` | subtask → which worker | `LlmRouter` or a deterministic router |
| `Worker` | run one subtask as a governed sub-session | `codeWorker`, `toolWorker`, `cliWorker` |
| `ModelProvider` | rent a model (BYOK) | `BedrockProvider` (fetch-only, no SDK) |
| `AcceptanceSeam` | judge the run against a contract | wire in `octopus-intent` |

Nothing here is locked to a vendor: the agent loop is **ours**, the model is a
swappable backend behind `ModelProvider`.

## Heterogeneous workers, one governance

Every worker returns the same `WorkerResult` — `{ outcome, output, workHead,
logHead, verified, record }` — regardless of what it wraps. The `record` is the
sub-session's two chains (work spine + evidence log), so a judge can re-verify it
independently.

- **`codeWorker` / `toolWorker`** — Reef's own agentic loop (an
  [`AgentWorker`](../packages/agent/src/worker.ts) `Driver`). The model is rented
  through `ModelProvider` (BYOK). Every action is gated by `reefAllowlist`,
  confined by an executor, and minted as evidence. `toolWorker` calls MCP / HTTP /
  API tools via a governed `tool` action, allowlisted **by name**.
- **`cliWorker`** — wraps an **external** agent CLI we did not write (Claude Code,
  Codex, …) via a configurable `buildArgv`. An external agent needs the network
  and its own auth, so — unlike our own workers — we do **not** run it in the OS
  sandbox. Instead we run it confined to a workspace and capture its file
  **effects**: a before/after content-hash diff, recorded as evidence. The
  governed sub-session proves the invocation and exactly which files were
  created / modified / deleted.

## Acceptance is a machine-check, not a rubber stamp

Wire [`octopus-intent`](https://github.com/octoryn/octopus-intent) as the judge and
the conductor stops accepting "all subtasks completed." Instead it runs
`checkContract` over a worker's **actual** sub-session `record` and returns a
per-criterion verdict against a contract you set:

```
verdict = unmet
  ✓ reached done
  ✗ transition into done was by the agent, not a human   (separation of duties)
  ✓ no forbidden denial evidence
```

That `met: false` is the point — a rubber stamp would have said `met`. The verdict
is recorded in the ledger as `orchestration.acceptance`, so *why* a run was (or
was not) accepted is itself part of the tamper-evident record.

Reef never imports `octopus-intent`; the checker consumes Reef's output. The
`record` shape is Reef-native but structurally identical to the checker's
`SessionRecord`, so the two compose without coupling.

## Verifying a ledger

```ts
import { Orchestrator, toolWorker, verifyLedger } from "@octopus-reef/agent";

const result = await orchestrator.orchestrate("introduce Octopus to a prospect");

result.verified;                      // the ledger independently re-verifies
verifyLedger(result.ledger);          // …and anyone can re-check it, store-untrusting
result.ledger.evidence.map(e => e.kind);
// [ 'orchestration.plan', 'orchestration.route', 'orchestration.result',
//   'orchestration.acceptance', 'orchestration.done' ]
```

Change any content in `result.ledger` and `verifyLedger` returns `false`. Each
`orchestration.result` pins `workHead` + `logHead` of a real governed
sub-session, so the ledger is not just self-consistent — it is bound to the actual
work.

## The honest scope

- **We prove effects, not thoughts.** For an external CLI we capture the file
  diff and the governed record — not the agent's internal reasoning. We claim
  exactly what we can show.
- **Governance is the moat, not routing.** Planning and routing *quality* are
  tunable (a better planner is a drop-in). What is hard to reproduce is the
  provable, swap-proof ledger and the real acceptance check — so that is what Reef
  invests in.
- **BYOK.** You bring your own model key. Reef is the governance and evidence
  layer, not a token reseller.
