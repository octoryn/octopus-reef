/**
 * @octopus-reef/adapter-runtime — octopus-runtime as Reef's real authorization gate.
 *
 * Reef's engine defines its `Authorizer`/`Principal` ports intentionally
 * offline, and they are STRUCTURALLY IDENTICAL to `octopus-runtime`'s
 * (`can(principal, action, resource?)` → boolean). So an `octopus-runtime`
 * authorizer — RBAC, OIDC, whatever a deployment configures — governs a Reef
 * session directly, with the engine still dependency-light. This package is
 * where the `octopus-runtime` dependency lives, so nothing leaks into the engine.
 *
 * Typical wiring: stack Reef's command allowlist (WHAT may run) under a runtime
 * authorizer (WHO may act) with {@link requireAll} — both must agree.
 *
 *   const authorizer = requireAll(reefAllowlist(), runtimeAuthorizer);
 *   new GovernedSession({ ..., authorizer, principal });
 */
import {
  allowAll as runtimeAllowAllImpl,
  LOCAL_PRINCIPAL as runtimeLocalPrincipalImpl,
} from "octopus-runtime";
import type { Authorizer, Principal } from "@octopus-reef/engine";

export { requireAll } from "@octopus-reef/engine";

/**
 * `octopus-runtime`'s open-default authorizer, typed as a Reef {@link Authorizer}.
 * The `satisfies` proves the structural compatibility at compile time — if either
 * project changed the port shape, this would stop building.
 */
export const runtimeAllowAll: Authorizer =
  runtimeAllowAllImpl satisfies Authorizer;

/** `octopus-runtime`'s local single-user principal, typed as a Reef {@link Principal}. */
export const runtimeLocalPrincipal: Principal =
  runtimeLocalPrincipalImpl satisfies Principal;

/**
 * Adapt any `octopus-runtime` authorizer into a Reef {@link Authorizer}. It's an
 * identity at runtime (the interfaces are the same); the value is the explicit,
 * type-checked seam and a single place to evolve the mapping if the two ever
 * diverge.
 */
export function fromRuntimeAuthorizer(authorizer: Authorizer): Authorizer {
  return authorizer;
}
