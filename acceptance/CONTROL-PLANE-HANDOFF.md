# Reef Control Plane Handoff

Branch: `reef-control-plane`

## Scope

Implemented the real Reef control plane in `packages/gateway` with TypeScript/Node, offline defaults, deployable provider seams, evidence-backed gateway decisions, and store-untrusting verification.

## Phase Summary

- G0: Gateway package scaffold, config, SQLite/Postgres DB seam, migrations, deploy files, health/readiness, and tamper-evident gateway ledger.
- G1: Authenticated completion endpoint, JWT verification, entitlement checks, Bedrock-or-local provider routing, usage metering, and denial evidence.
- G2: DB-backed quota, cost/usage ledger, local billing adapter, Stripe stub adapter, quota endpoint, and fail-closed over-quota denial.
- G3: Signup/login token issuance, account/license records, and license revoke denial.
- G4: Local OIDC SSO, teams/members/roles, team audit, and team evidence.
- G5: Priority/SLA plan routing with tier evidence and honest plan reporting.
- G6: Commercial/editor gateway wiring for signed JWT real gateway auth while preserving the offline stub path; end-to-end real gateway client test with verify green and tamper red.

## Verification

Acceptance notes and captured outputs are in:

- `acceptance/G0.md` through `acceptance/G6.md`
- `acceptance/artifacts/G0/` through `acceptance/artifacts/G6/`

The final G6 pass covered:

- Gateway source tests G0-G6.
- Commercial package typecheck.
- IDE typecheck.
- Existing server tests, including legacy stub gateway behavior.
- ESLint for touched Node packages.
- Gateway and commercial builds.
- `git diff --check`.

## Deployment Notes

- Default DB is SQLite (`REEF_GATEWAY_DB_URL=sqlite:...`); Postgres is available through `postgres://...`.
- Real Bedrock routing is selected only when `AWS_BEARER_TOKEN_BEDROCK` is set; otherwise the deterministic local provider is used.
- Deployment secrets must be supplied through env (`REEF_GATEWAY_JWT_SECRET`, `REEF_GATEWAY_LEDGER_SECRET`, provider keys, admin token).
- Docker and Compose files live in `packages/gateway`.
- Full env documentation is in `packages/gateway/CONFIG.md`.
