**English** | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing to Reef

Reef is built to a house standard: **everything ships green, and every
non-trivial change is adversarially reviewed before it's called done.**

## Setup

```bash
npm ci            # Node >= 22
npm run verify:all
```

`verify:all` is the gate: typecheck (libs + web + ide) · prettier · eslint ·
tests · all builds. CI runs the same gate plus a Docker image build + smoke test.
Nothing merges red.

## Layout

A monorepo of small, single-purpose packages (npm workspaces, ESM, TypeScript
strict):

| package | role |
| --- | --- |
| `engine` | the governed session — evidence + workstate + gate + executor + replay. Offline, dependency-light. **The governance lives here; every other package is thin.** |
| `protocol` | the shared HTTP/SSE wire contract |
| `agent` | the conductor — route + govern + prove a fleet of heterogeneous workers (Worker Ledger). Composes the engine; never imports the acceptance checker. |
| `driver-claude` | the real Claude agent driver (its own package so the engine stays offline) |
| `server` | the daemon (HTTP + SSE) every surface shares |
| `cli` · `web` · `ide` | the surfaces (terminal · Vite/React · VS Code) |

The engine **never reinvents** hashing, chains, or the work state machine — it
composes `octopus-evidence` and `octopus-workstate`.

## Working rhythm

1. Build the change to green.
2. **Adversarial review** — multi-dimension finders, then a skeptic that defaults
   to *refuted*; only reproduced findings count. Every fix lands with a
   regression test.
3. Re-verify (fixes can introduce new holes — keep reviewing until a round finds
   no real HIGH/MED).
4. Update `docs/DELIVERY-PLAN.md` and open a focused PR.

## Conventions

- Match the surrounding code's naming, comment density, and idiom.
- Prefer confined, testable seams over broad surface area.
- Security-relevant code (the gate, the executor/sandbox, the server) gets an
  explicit adversarial pass — see [SECURITY.md](SECURITY.md) for the threat model
  and the honest limits we hold ourselves to.
- Commit messages: imperative subject, a body explaining *why*.
