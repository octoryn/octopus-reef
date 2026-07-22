import type {
  VerificationQueue,
  VerificationStore,
} from "./ports.js";

export interface VerificationDispatchPublisherOptions {
  readonly ownerId: string;
  readonly store: VerificationStore;
  readonly queue: VerificationQueue;
  readonly leaseMs?: number;
  readonly retryBaseMs?: number;
  readonly now?: () => string;
}

export class VerificationDispatchPublisher {
  readonly #options: VerificationDispatchPublisherOptions;
  readonly #now: () => string;

  constructor(options: VerificationDispatchPublisherOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async drainOnce(limit = 25): Promise<number> {
    const records = await this.#options.store.claimOutbox(
      this.#options.ownerId,
      this.#options.leaseMs ?? 30_000,
      limit,
    );
    let published = 0;
    for (const record of records) {
      try {
        await this.#options.queue.enqueue(
          {
            organisationRef: record.organisationRef,
            projectRef: record.projectRef,
          },
          record.runRef,
          record.attempt,
          Math.max(0, Date.parse(record.availableAt) - Date.parse(this.#now())),
        );
        await this.#options.store.markOutboxPublished(record.id, this.#options.ownerId);
        published++;
      } catch (error) {
        const delay = (this.#options.retryBaseMs ?? 500) * 2 ** Math.min(8, record.deliveryAttempts);
        await this.#options.store.retryOutbox(
          record.id,
          this.#options.ownerId,
          new Date(Date.parse(this.#now()) + delay).toISOString(),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return published;
  }
}
