# Generated Golden Stack acceptance fixture

This fixture is a deliberately small generated product bundle, not a mock
response. It contains a real Next.js frontend, FastAPI backend, PostgreSQL
migration/idempotency check, tests, production builds, application health smoke,
and Docker Compose deployment.

The verification Docker acceptance test materializes these files from a
digest-bound source descriptor into a fresh network-disabled sandbox and runs
the versioned trusted profile. A separate release step starts the same bundle
with Docker Compose and checks both services against PostgreSQL.
