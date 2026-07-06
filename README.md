**English** | [简体中文](README.zh-CN.md)

# Reef — the governed agentic engineering workspace

> Everyone ships agentic engineering. **Reef makes it provable.**

Reef is an open, evidence-backed alternative to closed agentic IDEs. It runs
agents across your codebases like any agentic workspace — then **proves every
action they took**. Each state transition is a tamper-evident link. Every run
replays. Every session verifies independently, without trusting the store.

> **Part of [Octopus Core](https://github.com/octoryn) — the open infrastructure stack for governed AI.** Reef is the *workspace surface* that composes the stack into one product. It never reinvents hashing, chains, or the work state machine — it builds on [`octopus-evidence`](https://github.com/octoryn/octopus-evidence) and [`octopus-workstate`](https://github.com/octoryn/octopus-workstate), and (on the roadmap) Runtime, Blackboard, Replay, Observe, Experience, Scout, and Inspect.

## Show vs prove

Closed agentic IDEs render governance as UI polish — a badge that says
"learnings applied," a credits meter, a list of PRs you have to trust. Reef
ships the substrate underneath:

| Closed IDEs *show* | Reef *proves* |
|---|---|
| "Applied learnings" | Every session moment is `octopus-evidence` on a tamper-evident chain |
| Cross-repo PRs in a log | The work spine is an `octopus-workstate` provenance graph (proposed → done) |
| "Est. credits used" | `reef verify` re-checks the whole session store-untrusting |
| A session you trust | A session you can independently verify and replay |

## Quickstart

```bash
npm install
npm run build

# Run a governed session (fully offline, no API key — mock driver)
node packages/cli/dist/cli.js run "add rate limiting to the API" --out ./.reef/demo

# Independently re-verify it, store-untrusting
node packages/cli/dist/cli.js verify ./.reef/demo

# See the gate deny a dangerous action
node packages/cli/dist/cli.js run "clean up the machine" --demo-denial
```

Every run emits a live event stream, then a proof block:

```
proof ─────────────────────────────────────────────
  work state   done   work links 5   evidence links 11
  ✓ verified  work spine: intact  evidence log: intact
```

## What "governed" means, concretely

A Reef **session** composes three primitives:

- **Work spine** (`octopus-workstate`) — the task is a `WorkItem` that moves
  `proposed → ready → claimed → in_progress → done`; each move is an
  evidence-chained `StateTransition`. Illegal moves are impossible.
- **Evidence log** (`octopus-evidence`) — every observation, action, gate
  ruling, and message is minted as `Evidence` on a tamper-evident chain.
- **Action gate** — every action an agent proposes is ruled on *before* it runs.
  A denied action never executes; the denial is itself recorded as evidence.

`reef verify` (and `loadSession`) re-derive every hash and re-fold both chains:
a tampered file fails to load rather than loading wrong.

## Surfaces

Reef is driver- and surface-agnostic; the governance lives in one engine
(`@octopus-reef/engine`) that every surface shares.

| Surface | Package | Status |
|---|---|---|
| **CLI** | `@octopus-reef/cli` | ✅ working (this repo) |
| **Engine** | `@octopus-reef/engine` | ✅ working (this repo) |
| Real agent driver (Claude Agent SDK) | `@octopus-reef/engine` | 🔜 roadmap M1 |
| **Server** (local daemon, one backend for all surfaces) | `@octopus-reef/server` | 🔜 roadmap M2 |
| **Web** | `@octopus-reef/web` | 🔜 roadmap M3 |
| **IDE** (VS Code) | `@octopus-reef/ide` | 🔜 roadmap M4 |
| **Docker** one-click | `docker/` | 🔜 roadmap M5 |
| Mobile | — | on hold |

See [docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md) for the full roadmap and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the stack composes.

## Development

```bash
npm run verify:all   # typecheck + format + lint + test + build (the quality gate)
npm test             # engine test suite
npm run reef -- run "try me"   # run the CLI from source via tsx
```

Node ≥ 22. Zero third-party runtime dependencies beyond the Octopus stack.

## License

Apache-2.0 © Ran Tao. Part of Octopus Core.
