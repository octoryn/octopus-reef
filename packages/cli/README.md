# Reef CLI

`reef` is the terminal surface for governed sessions. It runs offline with the mock driver when no model key is configured.

```bash
reef run "add rate limiting" --out ./reef-session
reef verify ./reef-session
reef replay ./reef-session
reef serve 4300 --out ./reef-sessions
```

Every command uses the same Reef evidence chain and workstate binding as the IDE and web surfaces:

- `run` creates a governed session and can persist `session.log.jsonl`, `workstate.jsonl`, and `session.json`.
- `verify` reloads the persisted session store-untrusting; a one-byte evidence or workstate tamper returns red.
- `replay` verifies first, then reconstructs the timeline from evidence.
- `serve` starts the local HTTP/SSE daemon used by the web and editor surfaces.

Audit helpers:

```bash
reef audit-pack ./reef-session --out ./reef-audit-pack
reef audit-verify ./reef-audit-pack
reef say-no-demo --out ./reef-say-no
```
