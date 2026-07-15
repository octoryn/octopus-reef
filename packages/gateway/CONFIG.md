# Reef Gateway Configuration

The gateway runs offline by default with SQLite and a deterministic local model. Deployment secrets stay in the environment; none are committed.

| Env var | Required | Default | Purpose |
| --- | --- | --- | --- |
| `REEF_GATEWAY_HOST` | no | `127.0.0.1` | HTTP bind host. Use `0.0.0.0` only in a container or controlled deployment. |
| `REEF_GATEWAY_PORT` | no | `8787` | HTTP bind port. |
| `REEF_GATEWAY_DB_URL` | no | `sqlite:.reef-gateway/gateway.sqlite` | `sqlite:<path>`, `sqlite::memory:`, or `postgres://...`. |
| `REEF_GATEWAY_LEDGER_SECRET` | deploy yes | unset | Optional HMAC key for evidence and chain links. Set in deployments for untrusted stores. |
| `REEF_GATEWAY_JWT_SECRET` | deploy yes | ephemeral local key | HMAC key used to sign gateway JWTs. If unset, the process generates a local-only key and issued tokens expire on restart. |
| `REEF_GATEWAY_ADMIN_TOKEN` | no | unset | Bearer token for local administrative setup endpoints. If unset, admin endpoints fail closed. |
| `REEF_GATEWAY_RATE_LIMIT_WINDOW_MS` | no | `60000` | Sliding window for per-token/IP rate limiting. |
| `REEF_GATEWAY_RATE_LIMIT_REQUESTS` | no | `60` | Request allowance per window. |
| `REEF_GATEWAY_DEFAULT_QUOTA_TOKENS` | no | `10000` | Default account token quota. |
| `REEF_GATEWAY_TOKEN_TTL_SECONDS` | no | `3600` | JWT lifetime for login/signup tokens. |
| `REEF_GATEWAY_LOCAL_PRICE_PER_1K_TOKENS` | no | `0.002` | Local billing-ledger price used to compute honest offline cost records. |
| `REEF_GATEWAY_BEDROCK_MODEL` | no | Reef agent default | Bedrock model id when using the real Bedrock provider. |
| `AWS_BEARER_TOKEN_BEDROCK` | no | unset | When set, completions route to the real `BedrockProvider`; otherwise the local deterministic model stub is used. |
| `AWS_REGION` | no | `us-west-2` | Bedrock region. |
| `REEF_GATEWAY_OIDC_ISSUER` | no | local dev IdP | OIDC issuer for SSO. Defaults to the bundled loopback dev provider in tests/dev. |
| `REEF_GATEWAY_OIDC_CLIENT_ID` | no | `reef-local-dev` | OIDC client id. |
| `REEF_GATEWAY_OIDC_REDIRECT_URI` | no | `http://127.0.0.1:8787/v1/sso/callback` | OIDC redirect URI. |
| `REEF_GATEWAY_STRIPE_API_KEY` | no | unset | Stripe adapter credential. The adapter is present but calls are explicitly unimplemented until a real key/integration is supplied. |

Health endpoints:

- `GET /health` checks process liveness.
- `GET /ready` checks database migration and ledger readability.
- `GET /v1/verify` reloads the gateway ledger from the configured store and verifies evidence integrity, link integrity, expected length, and expected head.
