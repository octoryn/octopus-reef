/**
 * EvidenceLog — the session's full, replayable record.
 *
 * Where `octopus-workstate` tracks the *work spine* (proposed → done), the
 * EvidenceLog captures every fine-grained session moment (observations,
 * actions, gate rulings, messages) as an `octopus-evidence` chain. Both are
 * tamper-evident; together they are the whole provable session.
 *
 * This is a thin, honest wrapper over `octopus-evidence`: it never reimplements
 * hashing or linkage — it composes `createEvidence` + `nextLink` + `verifyChain`.
 */
import {
  createEvidence,
  nextLink,
  chainHead,
  verifyChain,
  verifyEvidence,
  type Evidence,
  type EvidenceInput,
  type ChainLink,
  type ChainVerification,
} from "octopus-evidence";

export interface EvidenceLogOptions {
  /** HMAC key binding every evidence and link tamper-evidently (keyed mode). */
  readonly integritySecret?: string;
}

/** One appended record: the Evidence and the chain link that commits it. */
export interface LogRecord {
  readonly evidence: Evidence;
  readonly link: ChainLink;
}

export interface VerifyLogOptions {
  readonly expectedLength?: number;
  readonly expectedHead?: string;
}

export class EvidenceLog {
  readonly #secret: string | undefined;
  readonly #evidences: Evidence[] = [];
  readonly #chain: ChainLink[] = [];

  constructor(options: EvidenceLogOptions = {}) {
    this.#secret = options.integritySecret;
  }

  /** Mint `input` as Evidence and append it to the chain. Returns the record. */
  append(input: EvidenceInput): LogRecord {
    const evidence = createEvidence(
      input,
      this.#secret !== undefined ? { integritySecret: this.#secret } : {},
    );
    const link = nextLink(this.#chain, evidence.id, this.#secret);
    this.#evidences.push(evidence);
    this.#chain.push(link);
    return { evidence, link };
  }

  get length(): number {
    return this.#chain.length;
  }

  get head(): string {
    return chainHead(this.#chain);
  }

  records(): LogRecord[] {
    return this.#evidences.map((evidence, i) => ({
      evidence,
      link: this.#chain[i]!,
    }));
  }

  /**
   * Independently verify the whole log without trusting its store:
   *  1. every Evidence recomputes its own id + integrity,
   *  2. every link commits exactly its Evidence's id,
   *  3. the chain is contiguous and correctly linked (and matches an optional
   *     pinned length/head — the truncation guard).
   */
  verify(options: VerifyLogOptions = {}): ChainVerification {
    for (let i = 0; i < this.#evidences.length; i++) {
      if (!verifyEvidence(this.#evidences[i]!, this.#secret)) {
        return {
          ok: false,
          brokenAt: i,
          reason: `evidence ${i} failed its integrity check`,
        };
      }
    }
    for (let i = 0; i < this.#chain.length; i++) {
      if (this.#chain[i]!.contentHash !== this.#evidences[i]?.id) {
        return {
          ok: false,
          brokenAt: i,
          reason: `link ${i} does not commit its evidence id`,
        };
      }
    }
    return verifyChain(this.#chain, {
      ...(this.#secret !== undefined ? { secret: this.#secret } : {}),
      ...(options.expectedLength !== undefined
        ? { expectedLength: options.expectedLength }
        : {}),
      ...(options.expectedHead !== undefined
        ? { expectedHead: options.expectedHead }
        : {}),
    });
  }

  /**
   * Rebuild a log from stored records and re-verify it store-untrusting. A
   * record whose link does not recompute is rejected — a restored log always
   * passes its own {@link verify}.
   */
  static restore(
    records: readonly LogRecord[],
    options: EvidenceLogOptions = {},
  ): EvidenceLog {
    const log = new EvidenceLog(options);
    for (const r of records) {
      log.#evidences.push(r.evidence);
      log.#chain.push(r.link);
    }
    const check = log.verify();
    if (!check.ok) {
      throw new Error(
        `cannot restore EvidenceLog: ${check.reason} (at ${check.brokenAt})`,
      );
    }
    return log;
  }
}
