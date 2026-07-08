**English** | [简体中文](SECURITY.zh-CN.md)

# Security Policy

Reef is a *governance* tool — its whole value is that a session can be trusted.
So we hold its own security to a high bar and describe it honestly.

## Reporting a vulnerability

Please report privately — **do not** open a public issue for a security bug.
Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email `ran@octopusos.ai`. We aim to acknowledge within a
few days and to fix confirmed issues before any disclosure.

## What the guarantees actually are

**Tamper-evidence / verification.** Every session is a hash-chained evidence log
over a work spine, cross-bound to each other. `verify` / `replay` re-derive every
hash store-untrusting.

- *Unkeyed* (default): detects accidental damage and partial tampering. It does
  **not** stop a writer with file access who re-mints the whole session — a full
  re-mint verifies clean.
- *Keyed* (`--secret` / `integritySecret`): every field and link is HMAC-bound;
  no field can be forged without the key. Use keyed mode for an untrusted store.

**Execution safety.** A real command runs only after (1) a tripwire, (2) the
`reefAllowlist` (allow-known-safe; the `DefaultGate` denylist is a backstop, not
the boundary), and (3) a confined executor. The `SandboxExecutor` (opt-in, via
`--sandbox`) runs commands shell-free, with the network denied, writes confined
to the workspace, reads of the real `$HOME`'s secret *contents* denied, git's
config-driven code-execution neutralised, a throwaway `HOME`, and a
process-group timeout.

### The honest limit

The local sandbox (`sandbox-exec` on macOS; best-effort elsewhere) is
**defense-in-depth, not a jail for a fully untrusted repo.** A repo's own config
can still execute code; the sandbox stops that code from reaching secrets or the
network, but a determined attacker with a novel local-only vector is out of scope
for the local runner. **For a fully untrusted repo, run Reef in the container**
(`docker run` / `docker compose up`), where execution is isolated by the OS.
This boundary is enforced in code (Reef refuses to run commands when the
workspace root is your home directory) and was hardened over ten adversarial
review rounds; we still treat new findings as real.

### The conductor's honest scope

The conductor (`@octopus-reef/agent`) governs a *fleet*, and is explicit about
what it can and cannot prove:

- **Worker Ledger.** The run is a hash-chained `octopus-evidence` log; each result
  pins its sub-session's heads, so a swapped or edited sub-session breaks
  verification. The same keyed/unkeyed limits above apply.
- **External CLIs are not OS-sandboxed.** A `cliWorker` wraps an agent that needs
  the network and its own auth, so it runs confined to a workspace (not in the
  sandbox). We capture its file **effects** (a content-hash diff) as evidence — we
  prove *what it changed*, not its internal reasoning, and we do not claim to
  contain a hostile external CLI. Run untrusted work in the container.
- **BYOK.** Model keys are the operator's; Reef reads them from the environment
  and does not persist or transmit them anywhere but the model endpoint.

## Scope

In scope: evidence forgery that verifies clean (keyed mode), sandbox escapes that
read secrets / write outside the workspace / reach the network, path-traversal in
the server's static file serving, Worker Ledger forgery that verifies clean, and
auth/verification bypasses.

Out of scope: attacks requiring an already-compromised host; the unkeyed-mode
re-mint limitation (documented, by design); denial of service from a hostile
local repo.
