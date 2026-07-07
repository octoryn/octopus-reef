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

## M4 — IDE surface (VS Code) ✅
`@octopus-reef/ide` — a VS Code extension (the VS Code framework, not a fork).
- Commands: **Reef: Run Governed Session** (prompts for a task, streams its
  evidence into a webview panel — the shared deep-sea/signal-teal timeline + proof
  block) and **Reef: Verify Last Session**. `reef.serverUrl` setting.
- The extension host owns the daemon connection (fetch + a hand-rolled SSE reader,
  since Node has no `EventSource`); the webview is pure presentation fed via
  `postMessage`, under a strict nonce CSP. Bundled to a single CJS file with
  esbuild (`vscode` external).
- Typechecks against `@types/vscode`; the SSE frame parser (`drainSSE`) is
  unit-tested (chunk-boundary reassembly, malformed-frame tolerance).
- Verified to compile + bundle + export `activate`/`deactivate` here; the final
  visual run (F5 / install the .vsix) is a one-step check in VS Code itself
  (no VS Code runtime in this build environment).

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

## M6 — Deepen stack integration ✅ (7 of 7 integrated)
Wire the stack modules behind the engine's seams — the light, well-fitting ones
first; the heavy/ill-shaped ones deferred with honest reasons.
- ✅ **Replay** — byte-for-byte session reconstruction from the evidence log.
  `replaySession(dir)` / `reef replay <dir>`: load + re-verify store-untrusting,
  then reconstruct the full `ReefEvent` timeline from the verified log
  (reconstructed events equal what the session emitted live; a tampered log cannot
  be replayed). Deep-equal regression test; tamper + keyed cases covered.
- ✅ **Runtime** — `octopus-runtime@0.7.0`'s `Authorizer` is byte-identical to the
  engine's port. `requireAll` stacks the command allowlist under it;
  `@octopus-reef/adapter-runtime` (where the dep lives) proves a runtime authorizer
  governs a real session (`satisfies` = compile-time compat proof).
- ✅ **Inspect** — `reef inspect [<dir>]` runs `octopus-inspect`'s static
  governance linter (secrets, agentic-OWASP 2026); exits non-zero on error-level
  holes. octopus-inspect only pulls octopus-evidence — no new heavy deps.
- ✅ **Observe** — `@octopus-reef/adapter-observe`: the INPUT boundary. An
  untrusted agent input (tool call / action) is validated into a canonical
  Observation via `octopus-observe` and bridged to evidence; malformed input is
  rejected at the boundary. Ready for an ingesting driver to route inputs through.
- ✅ **Blackboard** — `@octopus-reef/adapter-blackboard`: shared cognition for
  PARALLEL agents on one session. Agents `claim` tasks (a conflict prevents two
  doing the same work), `release` them, and `note` progress on a hash-chained
  timeline — multi-agent coordination that is itself auditable. Uses
  `octopus-blackboard` (better-sqlite3, which ships a prebuilt binary — installs
  clean on the slim Docker image, no build tools).
- ✅ **Experience** — `@octopus-reef/adapter-experience`: causal project memory
  (`octopus-experience`). `rememberDecision(memory, title, why)` records why a
  choice was made; `recall(memory, query)` surfaces the relevant prior context at
  session open. Ask *why*, not just *what*. `:memory:` or a persistent sqlite file.
- ✅ **Scout** — `@octopus-reef/adapter-scout`: a thin, ZERO-dependency HTTP client
  for a RUNNING `octopus-scout`. Scout is a full web/PDF ingestion service
  (fastify + playwright + postgres + redis) — the wrong thing to embed, so Reef
  *calls* it: at session open, `ScoutClient.scrape(url)` pulls task context
  governed by Scout's own policy (robots, rate-limit, hash-dedup, SSRF guard) and
  returns a normalized page to bring in as a session observation. `fetch` is
  injectable (testable against a fake Scout — no running service needed).

## M7 — Harden & publish 🔨
- ✅ **CI** — `.github/workflows/ci.yml`: the full house gate (`verify:all` —
  typecheck/lint/format/test/build across libs + web + ide; the macOS sandbox
  tests self-skip off darwin) plus a real Docker image build + smoke test (UI +
  governed API + verify from the container). `release.yml` publishes public
  packages only on a `v*` tag with an `NPM_TOKEN` secret — never on an ordinary push.
- ✅ **Docs** — `SECURITY.md` (real threat model + the honest sandbox limit + private
  reporting) and `CONTRIBUTING.md` (house standard + adversarial-review rhythm);
  README replay note corrected to shipped.
- 🔜 **Bilingual (zh)** house docs.
- 🔜 **Publish** — packages are publish-ready (metadata/exports/files set); the
  actual `npm publish` + tag is a deliberate, maintainer-gated step (held for
  explicit go — it's public and irreversible).
- Review status: the engine/gate/executor/sandbox converged over ten adversarial
  rounds (M0 + M1b). The surfaces (server/web/ide) are lower-risk; their
  security-relevant bits (SSE, static-serving path-traversal, webview CSP) are
  tested. A dedicated surface-review round is the remaining M7 hardening item.

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
