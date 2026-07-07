/**
 * M6 (Runtime) — octopus-runtime drops in as Reef's authorization gate. These
 * tests prove the ports are genuinely interchangeable: a runtime authorizer +
 * principal govern a real GovernedSession that verifies, and `requireAll` stacks
 * the command allowlist under it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GovernedSession,
  MockDriver,
  reefAllowlist,
  requireAll,
  type Authorizer,
} from "@octopus-reef/engine";
import {
  runtimeAllowAll,
  runtimeLocalPrincipal,
  fromRuntimeAuthorizer,
} from "../src/index.js";

function clock(): () => string {
  let n = 0;
  return () => new Date(Date.UTC(2026, 6, 7, 0, 0, n++)).toISOString();
}

test("adapter-runtime: a runtime authorizer + principal govern a Reef session", async () => {
  const session = new GovernedSession({
    id: "rt",
    task: "governed by octopus-runtime",
    driver: new MockDriver(),
    authorizer: fromRuntimeAuthorizer(runtimeAllowAll),
    principal: runtimeLocalPrincipal,
    now: clock(),
  });
  const { snapshot } = await session.run();
  assert.equal(snapshot.outcome, "completed");
  assert.equal(session.verify().ok, true);
});

test("adapter-runtime: requireAll stacks the allowlist under an authorizer", async () => {
  const P = runtimeLocalPrincipal;
  const deny: Authorizer = { can: () => false };

  // either denies → denied
  const gated = requireAll(reefAllowlist(), deny);
  assert.equal(await gated.can(P, "reef.action.read"), false);

  // both allow → allowed; but the allowlist still denies a dangerous command
  const stacked = requireAll(reefAllowlist(), runtimeAllowAll);
  assert.equal(await stacked.can(P, "reef.action.read"), true);
  assert.equal(
    await stacked.can(P, "reef.action.command", {
      type: "command",
      id: "rm -rf /",
    }),
    false,
  );

  // empty conjunction grants nothing (safe default)
  assert.equal(await requireAll().can(P, "reef.action.read"), false);
});
