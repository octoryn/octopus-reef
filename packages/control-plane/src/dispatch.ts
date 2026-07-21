import type { RunDispatchOutbox, RunQueue } from "./ports.js";

export interface RunDispatchPublisherOptions {
  readonly ownerId: string;
  readonly outbox: RunDispatchOutbox;
  readonly queue: RunQueue;
  readonly leaseMs?: number;
  readonly batchSize?: number;
  readonly retryBaseMs?: number;
  readonly now?: () => string;
}

/**
 * At-least-once outbox publisher. A crash after enqueue and before `published`
 * intentionally creates a duplicate delivery; worker fencing/idempotency makes
 * that safe while avoiding any lost dispatch.
 */
export class RunDispatchPublisher {
  readonly #options: RunDispatchPublisherOptions;
  readonly #now: () => string;

  constructor(options: RunDispatchPublisherOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async drainOnce(): Promise<number> {
    const records = await this.#options.outbox.claim(
      this.#options.ownerId,
      this.#options.leaseMs ?? 30_000,
      this.#options.batchSize ?? 100,
    );
    for (const record of records) {
      try {
        await this.#options.queue.enqueue(record, record.runId, {
          attempt: record.attempt,
          delayMs: Math.max(
            0,
            Date.parse(record.availableAt) - Date.parse(this.#now()),
          ),
        });
        await this.#options.outbox.published(record.id, this.#options.ownerId);
      } catch (error) {
        const delay =
          (this.#options.retryBaseMs ?? 1_000) *
          Math.min(60, 2 ** Math.min(10, record.deliveryAttempts));
        await this.#options.outbox.retry(
          record.id,
          this.#options.ownerId,
          new Date(Date.parse(this.#now()) + delay).toISOString(),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return records.length;
  }
}
