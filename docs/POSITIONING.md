# Reef Positioning

Reef is the agentic engineering workspace you can prove.

The market can already generate code, run tasks, and show polished agent logs.
Reef's wedge is narrower and harder to fake: verifiable governance, replay, and
honest economics. Every action, gate ruling, replay proof, and fleet decision is
an evidence link that can be checked store-untrusting. Green means the hashes
and state transitions re-derived; red means somebody changed the record.

## Audit Wedge

Reef ships the audit trail as a product feature, not as a screenshot:

- A governed session is backed by `octopus-workstate` plus
  `octopus-evidence`.
- `reef verify` re-folds the work spine and evidence log without trusting the
  store.
- `reef replay` reconstructs the run only after verification passes.
- `reef audit-pack` exports a self-contained bundle: evidence chain, Worker
  Ledger, replay verification proof, and control mapping language for SOC 2
  Type II, ISO-42001, and EU AI Act audit-trail reviews.
- `reef audit-verify` verifies that pack store-untrusting; a one-byte tamper of
  a listed artifact fails the pack.
- The say-NO demo proves the gate can deny an unreviewed dangerous change before
  execution, with the denial recorded as evidence.

## Fleet Accountability

The conductor in `@octopus-reef/agent` lets Reef govern more than one agent at a
time. Each sub-session remains a normal governed session with its own evidence
chain. The fleet adds a Worker Ledger over `plan -> route -> result ->
acceptance`, and each result pins the sub-session chain heads. Session tamper
turns the session red; ledger tamper turns the fleet red.

## Honest Economics

Reef is BYOK-first: you bring the provider key, you pay the provider, and Reef
adds no model markup. The product surfaces this directly in Account and Usage:

- Usage is provider/API-sourced and labeled by source.
- Missing provider data stays `not available`; missing keys stay `pending-key`.
- Reef does not invent a `0/50` balance, synthetic credits, or an opaque credit
  meter.
- Your key, your data, local-first is the default posture for the open source
  product.

That is the competitive contrast: other tools can show a credit counter or an
agent transcript. Reef proves the governed run and refuses to pretend unknown
economics are known.
