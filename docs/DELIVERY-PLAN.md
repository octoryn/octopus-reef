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

## M1 — Real agent driver (Claude Agent SDK) + real execution safety 🔜
Make `reef run` do real agentic coding when `ANTHROPIC_API_KEY` is present,
behind the identical `Driver` interface. Mock stays the default (offline/CI/Docker).
- ClaudeDriver wrapping the Claude Agent SDK; tool calls surface as `ActionRequest`s.
- Streaming turns → `DriverStep`s → evidence links.
- Read the `claude-api` skill before implementing; pin the model id.
- **Execution safety (the real gate, replacing reliance on the denylist):** a
  real command NEVER runs on `DefaultGate`'s say-so. It must pass an
  **allowlist policy** (`octopus-runtime` Principal/decision — allow-known-safe,
  else deny-or-ask) AND run inside an **OS sandbox** (restricted fs/network).
  `DefaultGate` stays as a cheap pre-filter tripwire behind that.
- Acceptance: a real task edits real files under governance; a disallowed/unknown
  command is denied or requires approval (never silently executed); session verifies.

## M2 — Server daemon 🔜
`@octopus-reef/server` — a local HTTP + WebSocket daemon hosting the engine so
CLI, IDE, and Web share one governed session backend.
- Wire protocol package `@octopus-reef/protocol` (Session/Turn/Event/Action).
- WS event stream = the same `ReefEvent`s the engine emits.
- `GET /sessions/:id/verify` → store-untrusting verification over the wire.
- Acceptance: two clients observe one live session; both can verify it.

## M3 — Web surface 🔜
`@octopus-reef/web` — Vite + React, the Kiro-web equivalent. Connects to the
server over WS; renders the live governed session (the landing-page panel, real).
- Reuses the "forensic instrument" design language.
- Acceptance: run a session from the browser; watch the chain grow; verify green.

## M4 — IDE surface (VS Code) 🔜
`@octopus-reef/ide` — a VS Code extension (the VS Code framework, not a fork to
start). Session view, live evidence chain, gate prompts, `reef verify` command.
- Acceptance: run + verify a governed session inside VS Code.

## M5 — Docker one-click 🔜
`docker/` — one image, `docker run` brings up server + web; local `reef` connects.
- Keyless demo works out of the box (mock driver); mount a key for real agents.
- Acceptance: `docker compose up` → open the browser → run + verify a session.

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
