**English** | [简体中文](README.zh-CN.md)

# Reef — the governed agentic engineering workspace

> Everyone ships agentic engineering. **Reef makes it provable.**

Reef is an open, evidence-backed alternative to closed agentic IDEs. It runs
agents across your codebases like any agentic workspace — then **proves every
action they took**. Each state transition is a tamper-evident link. Every session
verifies independently, without trusting the store — and **replays byte-for-byte
from its evidence log** (`reef replay <dir>`): a persisted session is
re-verified store-untrusting, then its entire timeline is reconstructed, exactly
as it was emitted. Replay only succeeds on a log that verifies.

Reef governs a single agent's session — and, with its **conductor**
(`@octopus-reef/agent`), a whole *fleet* of them. The conductor sits **above** the
agent CLIs (Claude Code, Codex, Gemini, your own) instead of competing with them:
it routes each subtask to the best worker, governs each as its own verifiable
session, and binds the run into a **Worker Ledger** that proves what the fleet
did. See [docs/CONDUCTOR.md](docs/CONDUCTOR.md).

> **Part of [Octopus Core](https://github.com/octoryn) — the open infrastructure stack for governed AI.** Reef is the *workspace surface* that composes the stack into one product. It never reinvents hashing, chains, or the work state machine — it builds on [`octopus-evidence`](https://github.com/octoryn/octopus-evidence) and [`octopus-workstate`](https://github.com/octoryn/octopus-workstate); Replay is native, and Runtime, Blackboard, Observe, Experience, Scout, and Inspect integrate incrementally.

## Show vs prove

Closed agentic IDEs render governance as UI polish — a badge that says
"learnings applied," a credits meter, a list of PRs you have to trust. Reef
ships the substrate underneath:

| Closed IDEs *show* | Reef *proves* |
|---|---|
| "Applied learnings" | Every session moment is `octopus-evidence` on a tamper-evident chain |
| Cross-repo PRs in a log | The work spine is an `octopus-workstate` provenance graph (proposed → done) |
| "Est. credits used" | `reef verify` re-checks the whole session store-untrusting |
| A session you trust | A session you can independently verify (and replay-ready) |
| A fleet of agents you trust | A **Worker Ledger** proving what the fleet did (plan → route → result → acceptance) |

## The wedge: auditability plus honest economics

Reef's product wedge is the trust layer incumbents still mostly render as UI:

- **Audit Pack**: `reef audit-pack` exports the evidence chain, Worker Ledger,
  replay proof, and SOC 2 Type II / ISO-42001 / EU AI Act control map for a
  governed run. `reef audit-verify` re-checks the bundle store-untrusting; a
  one-byte edit to any listed artifact turns verification red.
- **Governance that can say NO**: denied actions fail closed before execution,
  and the denial is itself an evidence link. The `reef say-no-demo` command
  scripts the unreviewed-dangerous-change path offline.
- **Fleet accountability**: the Manager surface runs multiple governed sessions
  in parallel and binds them into a Worker Ledger, so "who did what" verifies at
  both the session and fleet level.
- **Honest economics**: BYOK means no Reef markup on model usage. Usage is
  provider/API-sourced and labeled by source; pending keys and missing provider
  data stay `pending-key` or `not available`. Reef never fabricates a `0/50`
  credit meter or hides model spend behind opaque credits.

## Quickstart

The whole workspace — governed backend **and** web UI — in one command:

```bash
docker compose up      # → http://localhost:4300  (offline, keyless)
```

The compose demo explicitly sets `REEF_ALLOW_UNAUTHENTICATED_REMOTE=1` because
the container must bind `0.0.0.0` for port publishing. For any shared host or
non-demo deployment, set `REEF_DAEMON_TOKEN` and restrict
`REEF_ALLOWED_ORIGINS`.

Or from source (Node ≥ 22):

```bash
npm install && npm run build

# Run a governed session (fully offline, no API key — mock driver)
node packages/cli/dist/cli.js run "add rate limiting to the API" --out ./.reef/demo

# Independently re-verify it, store-untrusting
node packages/cli/dist/cli.js verify ./.reef/demo

# Re-verify AND reconstruct the full timeline, byte-for-byte, from the log
node packages/cli/dist/cli.js replay ./.reef/demo

# Export and verify an audit bundle for the run
node packages/cli/dist/cli.js audit-pack ./.reef/demo --out ./.reef/demo-audit
node packages/cli/dist/cli.js audit-verify ./.reef/demo-audit

# Serve the daemon (HTTP + SSE) that the web/IDE surfaces share
node packages/cli/dist/cli.js serve 4300

# See the gate deny a dangerous action
node packages/cli/dist/cli.js say-no-demo --out ./.reef/say-no
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

## Execution safety (a real gate, not a denylist)

A real command runs only after (1) a tripwire, (2) the `reefAllowlist`
(allow-known-safe; the `DefaultGate` denylist is only a backstop), and (3) a
confined executor. The opt-in `SandboxExecutor` (`--sandbox`) runs commands
shell-free, with the network denied, writes confined to the workspace, reads of
the real `$HOME`'s secret *contents* denied, git's config-driven code-execution
neutralised, a throwaway `HOME`, and a process-group timeout.

**The honest limit:** the local sandbox is defense-in-depth, not a jail for a
fully untrusted repo — for that, run Reef in the container (`docker compose up`),
where execution is isolated by the OS. See [SECURITY.md](SECURITY.md).

## Daemon safety

The daemon is local-first by default: `reef-serve` binds to `127.0.0.1` unless a
host is supplied. Binding a non-loopback interface without `REEF_DAEMON_TOKEN`
is refused unless `REEF_ALLOW_UNAUTHENTICATED_REMOTE=1` is set for a trusted
demo. CORS defaults to loopback browser origins only; use
`REEF_ALLOWED_ORIGINS=https://your-ui.example` for deployments.

Custom stdio MCP powers can spawn local commands, so they are disabled by
default. Set `REEF_ALLOW_CUSTOM_MCP_STDIO=1` only when you trust the local user
and the configured MCP command.

## The conductor — prove what the *fleet* did

The engine proves one agent's session. The **conductor** (`@octopus-reef/agent`)
proves a fleet. It translates a task into subtasks, routes each to the best
worker, governs every worker as its own verifiable session, and binds the whole
run into a **Worker Ledger**: an `octopus-evidence` chain of
`plan → contract → route → result → acceptance → done` where each `result` pins
the head of the sub-session it came from. Swap a sub-session and the pin breaks;
change one byte and the ledger goes red.

Workers are heterogeneous, all governed the same way:

- **`codeWorker` / `toolWorker`** — our own agentic loop (a `Driver`); the model
  is rented through a provider seam (**BYOK**), and every action is gated,
  confined, and evidence-chained.
- **`cliWorker`** — wrap an external agent CLI we didn't write (Claude Code,
  Codex, …). It needs the network and its own auth, so we don't OS-sandbox it;
  instead we run it confined to a workspace and capture its file **effects** (a
  before/after content-hash diff) as evidence. Honestly scoped: we prove what it
  changed, not its internal reasoning.
- **`tool` workers** — MCP / HTTP / API calls, gated by an allowlist *by name*.

**Acceptance is a machine-check, not a rubber stamp.** Wire
[`octopus-intent`](https://github.com/octoryn/octopus-intent) as the judge and the
conductor doesn't accept "all subtasks completed" — it runs `checkContract` over a
worker's actual sub-session record and returns a per-criterion verdict against a
contract you set. It can, and does, say *no*. Everyone else shows you what an
agent did; Reef lets you prove what a *fleet* did.

## Surfaces

Reef is driver- and surface-agnostic; the governance lives in one engine
(`@octopus-reef/engine`) that every surface shares.

| Surface | Package | Status |
|---|---|---|
| **Engine** (governance: evidence + workstate + gate + executor + replay) | `@octopus-reef/engine` | ✅ |
| **CLI** (`run` · `verify` · `replay` · `serve`) | repo/Docker beta | ✅ |
| **Conductor** (route + govern + prove a fleet of heterogeneous workers) | `@octopus-reef/agent` | ✅ |
| **Execution control plane** (durable runs, recovery, leases, budgets, review) | `@octopus-reef/control-plane` | ✅ |
| **Real agent driver** (Claude) | `@octopus-reef/driver-claude` | ✅ |
| **Server** (daemon — one backend for all surfaces) | repo/Docker beta | ✅ |
| **Web** (Vite + React) | repo/Docker beta | ✅ |
| **IDE** (VS Code) | repo beta | ✅ |
| **Docker** one-click | `Dockerfile` · `docker-compose.yml` | ✅ |
| Mobile | — | on hold |

Public npm beta publishes the open foundation packages only:
`@octopus-reef/protocol`, `@octopus-reef/engine`, `@octopus-reef/agent`,
`@octopus-reef/control-plane`,
`@octopus-reef/driver-claude`, and the Octopus adapter packages. The server,
CLI, web, and IDE surfaces remain repo/Docker beta while the commercial gateway
seam is split out of the publishable server package.

See [docs/POSITIONING.md](docs/POSITIONING.md) for the audit wedge and honest
economics framing, [docs/CONDUCTOR.md](docs/CONDUCTOR.md) for the conductor,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the stack composes, and
[docs/DELIVERY-PLAN.md](docs/DELIVERY-PLAN.md) for the full roadmap.

## Development

```bash
npm run verify:all   # typecheck + format + lint + test + build (the quality gate)
npm test             # engine test suite
npm run reef -- run "try me"   # run the CLI from source via tsx
```

Node ≥ 22. The neutral core stays on the Octopus stack; optional PostgreSQL/AWS
adapters bring `pg` or the relevant AWS SDK clients only when selected.

## License

Apache-2.0 © Ran Tao. Part of Octopus Core.
