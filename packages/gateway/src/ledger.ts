import {
  chainHead,
  createEvidence,
  nextLink,
  verifyChain,
  verifyEvidence,
  type ChainLink,
  type Evidence,
} from "octopus-evidence";
import type { GatewayDb } from "./db.js";
import type {
  GatewayDecisionInput,
  GatewayDecisionRecord,
  GatewayLedgerAnchor,
  GatewayVerifyResult,
  StoredLedgerRecord,
} from "./types.js";

export interface GatewayLedgerOptions {
  readonly db: GatewayDb;
  readonly integritySecret?: string;
  readonly serviceId?: string;
  readonly now?: () => string;
}

export class GatewayLedger {
  readonly #db: GatewayDb;
  readonly #secret: string | undefined;
  readonly #serviceId: string;
  readonly #now: () => string;

  constructor(options: GatewayLedgerOptions) {
    this.#db = options.db;
    this.#secret = options.integritySecret;
    this.#serviceId = options.serviceId ?? "reef-gateway";
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async appendDecision(
    input: GatewayDecisionInput,
  ): Promise<GatewayDecisionRecord> {
    const existing = await this.#db.listLedgerRecords();
    const evidence = this.#evidenceFor(input);
    const chain = existing.map((record) => record.link);
    const link = nextLink(chain, evidence.id, this.#secret);
    const record: StoredLedgerRecord = {
      sequence: link.sequence,
      evidence,
      link,
      createdAt: this.#now(),
    };
    await this.#db.appendLedgerRecord(record);
    const anchor: GatewayLedgerAnchor = {
      head: link.hash,
      length: link.sequence + 1,
      updatedAt: record.createdAt,
    };
    await this.#db.writeLedgerAnchor(anchor);
    return {
      evidenceId: evidence.id,
      sequence: link.sequence,
      head: link.hash,
    };
  }

  async verify(): Promise<GatewayVerifyResult> {
    const checkedAt = this.#now();
    let records: readonly StoredLedgerRecord[];
    let anchor: GatewayLedgerAnchor | undefined;
    try {
      records = await this.#db.listLedgerRecords();
      anchor = await this.#db.readLedgerAnchor();
    } catch (error) {
      return {
        ok: false,
        source: "gateway-ledger",
        checkedAt,
        length: 0,
        head: chainHead([]),
        reason: `ledger store unreadable: ${messageOf(error)}`,
      };
    }

    const evidences = records.map((record) => record.evidence);
    const links = records.map((record) => record.link);
    const integrity = verifyEvidenceRecords(evidences, this.#secret);
    if (!integrity.ok) {
      return {
        ok: false,
        source: "gateway-ledger",
        checkedAt,
        length: records.length,
        head: chainHead(links),
        ...(anchor !== undefined
          ? { expectedLength: anchor.length, expectedHead: anchor.head }
          : {}),
        brokenAt: integrity.brokenAt,
        reason: integrity.reason,
      };
    }
    const binding = verifyLinkBindings(evidences, links);
    if (!binding.ok) {
      return {
        ok: false,
        source: "gateway-ledger",
        checkedAt,
        length: records.length,
        head: chainHead(links),
        ...(anchor !== undefined
          ? { expectedLength: anchor.length, expectedHead: anchor.head }
          : {}),
        brokenAt: binding.brokenAt,
        reason: binding.reason,
      };
    }
    const chain = verifyChain(links, {
      ...(this.#secret !== undefined ? { secret: this.#secret } : {}),
      ...(anchor !== undefined ? { expectedLength: anchor.length } : {}),
      ...(anchor !== undefined ? { expectedHead: anchor.head } : {}),
    });
    if (!chain.ok) {
      return {
        ok: false,
        source: "gateway-ledger",
        checkedAt,
        length: records.length,
        head: chainHead(links),
        ...(anchor !== undefined
          ? { expectedLength: anchor.length, expectedHead: anchor.head }
          : {}),
        brokenAt: chain.brokenAt,
        reason: chain.reason,
      };
    }
    return {
      ok: true,
      source: "gateway-ledger",
      checkedAt,
      length: records.length,
      head: chainHead(links),
      ...(anchor !== undefined
        ? { expectedLength: anchor.length, expectedHead: anchor.head }
        : {}),
    };
  }

  #evidenceFor(input: GatewayDecisionInput): Evidence {
    const subject = [
      ...(input.tenantId !== undefined
        ? [{ type: "tenant", id: input.tenantId }]
        : []),
      ...(input.accountId !== undefined
        ? [{ type: "account", id: input.accountId }]
        : []),
      ...(input.subject ?? []),
    ];
    return createEvidence(
      {
        kind: `reef.gateway.${input.decision}`,
        subject,
        ...(input.actorId !== undefined
          ? { actor: { type: "gateway-actor", id: input.actorId } }
          : {}),
        content: input.content,
        provenance: {
          source: this.#serviceId,
          method: input.method,
          at: this.#now(),
        },
      },
      this.#secret !== undefined ? { integritySecret: this.#secret } : {},
    );
  }
}

function verifyEvidenceRecords(
  evidences: readonly Evidence[],
  secret: string | undefined,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly brokenAt: number; readonly reason: string } {
  for (let i = 0; i < evidences.length; i++) {
    if (!verifyEvidence(evidences[i]!, secret)) {
      return {
        ok: false,
        brokenAt: i,
        reason: `evidence ${i} failed its integrity check`,
      };
    }
  }
  return { ok: true };
}

function verifyLinkBindings(
  evidences: readonly Evidence[],
  links: readonly ChainLink[],
):
  | { readonly ok: true }
  | { readonly ok: false; readonly brokenAt: number; readonly reason: string } {
  if (links.length !== evidences.length) {
    return {
      ok: false,
      brokenAt: Math.min(links.length, evidences.length),
      reason: "ledger record count does not match evidence/link count",
    };
  }
  for (let i = 0; i < links.length; i++) {
    if (links[i]!.contentHash !== evidences[i]!.id) {
      return {
        ok: false,
        brokenAt: i,
        reason: `link ${i} does not commit its evidence id`,
      };
    }
  }
  return { ok: true };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
