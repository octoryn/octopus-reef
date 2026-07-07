# Reef — Delivery Plan

Goal: an **open-source, commercial-grade equal to Kiro** — CLI + IDE (VS Code) +
Web (Mobile on hold) — that integrates the entire Octopus stack and ships a
one-click Docker environment. Built milestone-by-milestone, each green on the
house quality gate (typecheck + format + lint + test + build) and hardened by an
adversarial review round before it is called done.

**Differentiator held at every milestone:** every session is tamper-evident,
independently verifiable, and replayable. We do not add a surface that can't be
proven.

## Status legend
✅ done & green · 🔨 in progress · 🔜 queued · 🧊 on hold

---

## M0 — Governed engine + CLI foundation ✅
The provable substrate, working end-to-end.
- ✅ `@octopus-reef/engine`: `GovernedSession` composing `octopus-workstate`
  (work spine) + `octopus-evidence` (session log) + action gate.
- ✅ `EvidenceLog` (store-untrusting verify, tamper + reorder + truncation detection).
- ✅ `DefaultGate` (denies `rm -rf /`, force-push to protected branches, pipe-to-shell, …).
- ✅ `MockDriver` / `UnsafeDemoDriver` — offline, keyless; exercises the whole substrate.
- ✅ JSONL persistence + `loadSession` re-verification.
- ✅ `@octopus-reef/cli`: `reef run` / `reef verify`, live event stream, proof block.
- ✅ 34 tests green; full gate green; hardened over 4 adversarial review rounds
  (R1 22 HIGH → R2 5 → R3 1 → R4 gate-only, reframed).

**Gate scope decision (R4, founder-approved):** `DefaultGate` is a best-effort
*accident tripwire*, NOT a security boundary — a shell denylist can never be
complete, and chasing bypasses (quoting, `${IFS}`, pipes, …) does not converge.
It catches obvious catastrophic commands and is scoped honestly. **Real
command-execution safety is M1's job** (allowlist + sandbox), see below.

## M1 — Real agent driver (Claude) + real execution safety ✅
Make `reef run` do real agentic coding when `ANTHROPIC_API_KEY` is present,
behind the identical `Driver` interface. Mock stays the default (offline/CI/Docker).
- ✅ **M1a — governed planning**: `@octopus-reef/driver-claude` `ClaudeDriver`
  calls `claude-opus-4-8` (adaptive thinking, effort high, structured-output
  plan) and maps the plan to gated, evidence-chained `DriverStep`s. `reef run
  --claude`. No real execution yet — a dangerous planned command is still denied
  by the gate; no key → session fails gracefully. Network-free unit tests.
- ✅ **M1b — real execution safety** (converged over two 5-round adversarial
  campaigns): bidirectional gate protocol (driver proposes → session gates →
  executes only if allowed → result back to the driver); the `reefAllowlist`
  (allow-known-safe, `octopus-runtime`-compatible ports); a `WorkspaceExecutor`
  (symlink-safe path confinement, resolve-and-contain); and a `SandboxExecutor`
  (M1b-3) that runs allowlisted commands shell-free, no-network, writes confined
  to the workspace, reads of the real HOME denied (secret contents), git config
  code-exec neutralised, throwaway HOME, process-group timeout. `reef run
  --workspace <dir> --sandbox`. Full untrusted-repo isolation → the container (M5).
- Streaming turns → `DriverStep`s → evidence links.
- **Execution safety (the real gate, replacing reliance on the denylist):** a
  real command NEVER runs on `DefaultGate`'s say-so. It must pass an
  **allowlist policy** (`octopus-runtime` Principal/decision — allow-known-safe,
  else deny-or-ask) AND run inside an **OS sandbox** (restricted fs/network).
  `DefaultGate` stays as a cheap pre-filter tripwire behind that.
- Acceptance: a real task edits real files under governance; a disallowed/unknown
  command is denied or requires approval (never silently executed); session verifies.

## M2 — Server daemon ✅
`@octopus-reef/server` — a local HTTP + SSE daemon hosting the engine so CLI,
IDE, and Web share one governed session backend.
- Wire protocol package `@octopus-reef/protocol` — the shared request/event
  contract, re-exporting the engine's own value types so clients never drift.
- Live event stream = the same `ReefEvent`s the engine emits, streamed over
  Server-Sent Events (replayed to late subscribers so a client always sees the
  whole session). SSE, not WebSocket: no dependency, works in browser/Node/IDE,
  minimal supply chain for a governed tool. Clients act via POST, observe via SSE.
- `GET /sessions/:id/verify` → store-untrusting verification over the wire.
- `reef serve [<port>]` (and a `reef-serve` bin) start it; offline/keyless by
  default (mock driver) so the Docker image serves a working backend immediately.
- Acceptance MET: a test drives real HTTP against an ephemeral port where two
  independent clients observe one live session and both verify it (`ok`,
  `work: intact`, `log: intact`, `binding: bound`).

## M3 — Web surface ✅
`@octopus-reef/web` — Vite + React, the Kiro-web equivalent. Connects to the
daemon over HTTP + SSE (via `@octopus-reef/protocol` types); renders the live
governed session and its proof block.
- Reuses the "forensic instrument" design language (deep-sea + signal-teal).
- Start a task → the evidence timeline streams in live → a proof block seals with
  the verdict (work/log/binding) and the chain lengths.
- Same-origin by default (Vite dev-proxies `/sessions`; the Docker image will
  serve the built assets from the daemon), `VITE_REEF_SERVER` for a remote daemon.
- Acceptance MET (driven in a real browser against `reef serve`): running a task
  streamed 11 evidence rows and sealed with `✓ VERIFIED` — work/log intact,
  binding bound, 5 work links · 11 evidence links · 3 executed · 0 denied.

## M4 — IDE surface (VS Code) 🔜
`@octopus-reef/ide` — a VS Code extension (the VS Code framework, not a fork to
start). Session view, live evidence chain, gate prompts, `reef verify` command.
- Acceptance: run + verify a governed session inside VS Code.

## M5 — Docker one-click ✅
`Dockerfile` + `docker-compose.yml` — one image, one command, server **and** web
from a single process (`ReefServer` gained confined static-file serving so the
daemon hosts the built SPA).
- Multi-stage: build the libs (tsc) + web bundle (Vite), then a slim `node:22`
  runtime with pruned deps, running as the unprivileged `node` user with a
  `/health` HEALTHCHECK. Image ~360 MB.
- Keyless/offline out of the box (mock driver); set a key + real driver for live
  agents; optional `--persist` volume.
- Acceptance MET (real build + run on Docker 29): `docker run -p 4300:4300
  octopus-reef` → `GET /` serves the web UI, `POST /sessions` + `GET
  /sessions/:id/verify` returns `ok / intact / intact / bound`. `docker compose
  up` is the one-command form.

## M6 — Deepen stack integration 🔜
Wire the remaining modules behind the engine's seams:
- **Runtime** — replace `DefaultGate` internals with `octopus-runtime` Principal/decision gate.
- **Blackboard** — multi-agent shared cognition (parallel agents on one session).
- **Replay** — byte-for-byte session reconstruction from the evidence log.
- **Observe** — turn agent inputs into trusted Observations at the boundary.
- **Experience** — "why this knowledge is trusted" surfaced in the session.
- **Scout** — pull task context/evidence at session open.
- **Inspect** — governance lint over the workspace itself.

## M7 — Harden & publish 🔜
Bilingual house docs (README/ARCHITECTURE/DELIVERY-PLAN/CONTRIBUTING/SECURITY zh),
CI (`ci.yml`/`release.yml`), ≥1 adversarial review round per surface converged,
then publish packages + tag.

---

## Working rhythm (the loop)
Each iteration: pick the next milestone → build to green → adversarial review
(house process: multi-dim finders → skeptic default-refuted, fixes get
regression tests) → update this plan → report. Stop a review dimension only when
it returns no real HIGH/MED finding.

## Honest risks
- **Product ≠ infrastructure.** A workspace is a different game (distribution,
  retention, ops). Mitigation: keyless demo + Docker lower the first-user cost;
  we validate demand against the Octoryn Medical work-state mapping before over-investing.
- **Naming.** `Reef` is a provisional product name (unclaimed, on-brand, distinct
  from every existing repo word). Rename is cheap; the operator owns naming.
- **Real-driver safety.** M1 must keep every real tool call behind the gate; no
  action executes before a verdict.
