import type { AcceptanceVerifier } from "./ports.js";
import type { AcceptanceResult, AgentRun } from "./types.js";

export class KernelProofAcceptanceVerifier implements AcceptanceVerifier {
  verify(_run: AgentRun, proof: unknown): Promise<AcceptanceResult> {
    const verification = objectField(proof, "verification");
    const ok = verification?.["ok"] === true;
    return Promise.resolve({
      accepted: ok,
      reason: ok
        ? "Reef engine proof verified"
        : "Reef engine proof is missing or did not verify",
      ...(proof !== undefined ? { evidence: proof } : {}),
    });
  }
}

export interface AcceptanceContractResolver {
  resolve(run: AgentRun, acceptanceRef: string): Promise<unknown>;
}

export interface OctopusIntentVerdict {
  readonly met: boolean;
  readonly verdict: string;
  readonly [key: string]: unknown;
}

export type OctopusIntentChecker = (
  contract: unknown,
  record: unknown,
) => OctopusIntentVerdict;

/**
 * Deployment-neutral seam for octopus-intent's store-untrusting checker. The
 * checker is injected by deployments, so this public package never resolves a
 * sibling checkout or takes a file: dependency on octopus-intent.
 */
export class OctopusIntentAcceptanceVerifier implements AcceptanceVerifier {
  constructor(
    private readonly contracts: AcceptanceContractResolver,
    private readonly checkContract: OctopusIntentChecker,
  ) {}

  async verify(run: AgentRun, proof: unknown): Promise<AcceptanceResult> {
    if (run.acceptanceRef === undefined) {
      return new KernelProofAcceptanceVerifier().verify(run, proof);
    }
    const record = objectField(proof, "record");
    if (record === undefined) {
      return { accepted: false, reason: "kernel proof has no session record" };
    }
    const contract = await this.contracts.resolve(run, run.acceptanceRef);
    const verdict = this.checkContract(contract, record);
    return {
      accepted: verdict.met,
      reason: verdict.met
        ? "octopus-intent acceptance contract met"
        : `octopus-intent verdict: ${verdict.verdict}`,
      evidence: verdict,
    };
  }
}

function objectField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return field !== null && typeof field === "object"
    ? (field as Record<string, unknown>)
    : undefined;
}
