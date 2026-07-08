**English** | [简体中文](ARCHITECTURE.zh-CN.md)

# Reef — Architecture

Reef is a **surface over the Octopus stack**, not a new primitive. Its one job is
to compose the stack into a governed agentic workspace where every session is
provable. It never reimplements hashing, chains, or the work state machine.

## The one idea

A **session** is a governed wrapper around an agent. Two tamper-evident records
grow together as the agent works, and both must verify for the session to be
provable:

```
                        ┌──────────────────────────────────────┐
   task ──▶ GovernedSession                                     │
                        │   work spine        evidence log      │
                        │  (octopus-          (octopus-         │
                        │   workstate)         evidence)        │
   agent Driver ──steps─┤   proposed          session.created   │
   (mock | Claude SDK)  │     │                observation      │
                        │   ready             action.executed   │  every step
   each action ─▶ Gate ─┤   claimed           action.denied ◀── │  is a link
   (allow / deny)       │   in_progress       message           │
                        │   done              session.sealed    │
                        │     ▼                    ▼             │
                        │  workstate.jsonl    session.log.jsonl  │
                        └──────────────────────────────────────┘
                                        │
                            reef verify (store-untrusting):
                            re-derive every hash, re-fold both chains
```

## Packages

| Package | Job (one sentence) |
|---|---|
| `@octopus-reef/engine` | The governed session engine — composes workstate + evidence + gate + driver into a provable session. |
| `@octopus-reef/agent` | The conductor — plans, routes, and governs a fleet of heterogeneous workers into a verifiable Worker Ledger. |
| `@octopus-reef/cli` | The terminal surface: run and verify governed sessions. |
| `@octopus-reef/server` *(M2)* | Local daemon hosting the engine so all surfaces share one backend. |
| `@octopus-reef/web` *(M3)* | Browser surface over the server. |
| `@octopus-reef/ide` *(M4)* | VS Code surface over the server. |

## Engine internals

- **`GovernedSession`** (`session.ts`) — orchestrates the run: creates the
  `WorkItem`, advances it through legal transitions, iterates the driver, gates
  each action, emits `ReefEvent`s, and mints every moment as evidence.
- **`EvidenceLog`** (`log.ts`) — a thin, honest wrapper over `octopus-evidence`
  (`createEvidence` + `nextLink` + `verifyChain`). `verify()` checks: every
  evidence recomputes its id+integrity; every link commits its evidence; the
  chain is contiguous and correctly linked; and optional pinned length/head
  catch truncation. `restore()` rejects any broken record.
- **`ActionGate` / `DefaultGate`** (`gate.ts`) — the "unsafe execution is
  structurally impossible" seam. `DefaultGate` is a minimal built-in policy;
  `octopus-runtime` wires in behind this same interface at M6.
- **`Driver`** (`types.ts`, `driver.ts`) — the agent behind the session. Reef is
  driver-agnostic: `MockDriver` (offline/keyless, powers tests + Docker demo),
  and the Claude Agent SDK driver at M1, share one interface. The governance
  substrate is identical regardless of driver.
- **persistence** (`persist.ts`) — writes `workstate.jsonl` +
  `session.log.jsonl`; `loadSession` re-verifies both store-untrusting.

## Why two chains, not one

The **work spine** answers *what work exists, where it came from, and why it
moved state* (workstate's domain). The **evidence log** captures *every
fine-grained session moment* for replay. They are separate records with separate
domains; a session is provable only when **both** verify. This keeps each
Octopus primitive doing exactly its one job.

## From one session to a fleet — the conductor

The engine proves one session; `@octopus-reef/agent` composes it into a governed
**fleet**. The conductor never re-implements governance — each worker it routes to
is an ordinary `GovernedSession`, so every sub-session already has its own two
verifying chains. What the conductor adds is a **third** tamper-evident record —
the **Worker Ledger** — over the orchestration itself:

```
   task ─▶ Orchestrator
             plan ─▶ (contract) ─▶ route ─▶ result ─▶ … ─▶ acceptance ─▶ done
                                              │
                                    each result PINS the sub-session's
                                    (workHead, logHead) — swap-proof
```

Each entry is `octopus-evidence`; `verifyLedger` re-checks the chain
store-untrusting. Because a `result` pins the heads of a real governed
sub-session, the ledger is bound to the actual work, not just internally
consistent. Acceptance is optional and decoupled: a judge may run
`octopus-intent`'s `checkContract` over a worker's sub-session record, and its
verdict is recorded as `orchestration.acceptance`. The engine never imports the
checker. See [CONDUCTOR.md](CONDUCTOR.md).

## Design rules honored

- **Compose, don't reinvent.** Hashing, chains, and the state machine come from
  the published packages. Reef adds orchestration and surfaces, nothing crypto.
- **Store-untrusting by default.** Verification never trusts the files; it
  re-derives. A tampered session fails to load.
- **Keyless-capable.** The whole substrate runs offline with the mock driver, so
  tests, CI, and the Docker demo need no API key.
- **Gate before execute.** No action runs before a verdict; denials are evidence.
