**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — 2026-07-23

### Fixed

- Corrected PostgreSQL index-introspection quoting in the irreversible
  preflight workflow. The 0.2.1 tag failed before publication, so no 0.2.1 npm,
  GHCR, or GitHub Release artifacts were created.

### Changed

- Carries forward the exact migration/runtime binding, detached public audit,
  remote sandbox identity, and compatibility fixes prepared in 0.2.1 under a
  new immutable release identity.

## [0.2.1] — 2026-07-23

_Unpublished candidate: the immutable tag is retained as failed preflight
history, but no registry or Release artifacts were distributed._

### Fixed

- Made the published Verification SQL asset the single runtime migration source
  and added a build-time exact-byte binding gate. This supersedes 0.2.0, whose
  release-record migration digest described different bytes from the embedded
  runtime migration.
- Preserved the ordinary queue claim index actually created by 0.2.0 so upgraded
  and newly installed databases converge on the same PostgreSQL schema.
- Required the remote Golden Stack image to inject the current immutable API
  manifest instead of accepting a stale default runner image.

### Changed

- Release candidates now expose a public checksum-bound prerelease for detached
  black-box audit. Finalization attaches the audit without rewriting any audited
  bundle asset.
- Bumped the remote trusted profile identity to `1.0.2`.

## [0.2.0] — 2026-07-08

The conductor release: Reef now governs not just one agent's session but a whole
**fleet**, and proves what the fleet did.

### Added

- **The conductor** (`@octopus-reef/agent`) — a governed orchestrator that sits
  above the agent CLIs. It translates a task into subtasks (`Planner`), routes
  each to the best worker (`Router`), runs every worker as its own verifiable
  governed sub-session, and binds the whole run into a **Worker Ledger**: an
  `octopus-evidence` chain of `plan → contract → route → result → acceptance →
  done`, where each `result` pins the head of the sub-session it came from.
  `verifyLedger` re-checks it store-untrusting; one byte flips it to unverifiable.
- **Heterogeneous workers, one governance.** `codeWorker` / `toolWorker` run
  Reef's own agentic loop (model rented via a `ModelProvider` seam — BYOK); each
  action is gated, confined, and evidence-chained. `cliWorker` wraps an
  **external** agent CLI (Claude Code, Codex, …) via a configurable `buildArgv`,
  running it confined to a workspace and capturing its file **effects** (a
  before/after content-hash diff) as evidence — honestly scoped to what it
  changed, not its internal reasoning.
- **Acceptance as a real machine-check.** An `AcceptanceSeam` lets a judge run
  `octopus-intent`'s `checkContract` over a worker's actual sub-session `record`
  and return a per-criterion verdict against a contract — recorded in the ledger
  as `orchestration.acceptance`. It can, and does, say *no*. Reef never imports
  the checker; the two compose without coupling.
- **Governed `tool` action** in the engine — workers reach MCP / HTTP / API tools
  through a `ToolExecutor`, gated by `reefAllowlist` **by name**.
- **`ModelProvider` seam + `BedrockProvider`** — a fetch-only provider (no SDK)
  using a bearer token; the agent loop is ours, the model is a swappable backend.
- **Benchmark** (`bench/`) — SWE-bench-style tiered tasks with held-out grading,
  so the harness can answer "is it good enough?" with a score, not a vibe.

### Notes

- The moat is *provable* orchestration, not routing (which commodifies). Planning
  and routing quality are tunable drop-ins; the tamper-evident ledger and the real
  acceptance check are what Reef invests in.
- Still zero third-party runtime dependencies beyond the Octopus stack.

## [0.1.0] — 2026-07-05

Initial workspace release: the governed agentic engineering surface.

### Added

- **Engine** (`@octopus-reef/engine`) — the governed session: a work spine
  (`octopus-workstate`) and an evidence log (`octopus-evidence`) grow together,
  every action passes an `ActionGate` before it runs, and `verify` re-derives both
  chains store-untrusting.
- **Replay** — `reef replay <dir>` re-verifies a persisted session and reconstructs
  its full timeline byte-for-byte; replay only succeeds on a log that verifies.
- **Execution safety** — `reefAllowlist` (allow-known-safe) plus an opt-in
  `SandboxExecutor`: shell-free, network denied, writes confined to the workspace,
  `$HOME` secrets unreadable, git config-driven execution neutralised.
- **Surfaces** — CLI (`run` · `verify` · `replay` · `serve`), a real Claude
  driver, a server daemon (HTTP + SSE), a Web UI (Vite + React), a VS Code IDE
  extension, and one-click Docker.

[0.2.2]: https://github.com/octoryn/octopus-reef/releases/tag/control-plane-v0.2.2
[0.2.1]: https://github.com/octoryn/octopus-reef/releases/tag/control-plane-v0.2.1
[0.2.0]: https://github.com/octoryn/octopus-reef/releases/tag/v0.2.0
[0.1.0]: https://github.com/octoryn/octopus-reef/releases/tag/v0.1.0
