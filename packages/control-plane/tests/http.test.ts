import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  ControlPlaneService,
  InMemoryControlPlaneStore,
  InMemoryHumanReviewGateway,
  InMemoryRunQueue,
  InfrastructureError,
  InfrastructureUnavailableError,
  createControlPlaneHttpHandler,
  type AgentRun,
  type TenantScope,
} from "../src/index.js";

class FailingStore extends InMemoryControlPlaneStore {
  constructor(private readonly failure: Error) {
    super();
  }

  override getByIdempotencyKey(
    _scope: TenantScope,
    _idempotencyKey: string,
  ): Promise<AgentRun | undefined> {
    return Promise.reject(this.failure);
  }
}

test("infrastructure failures return retryable 500/503 responses", async () => {
  for (const expected of [
    {
      failure: new InfrastructureError("storage operation failed"),
      status: 500,
      code: "INFRASTRUCTURE_FAILURE",
    },
    {
      failure: new InfrastructureUnavailableError("database unavailable"),
      status: 503,
      code: "INFRASTRUCTURE_UNAVAILABLE",
    },
  ]) {
    const store = new FailingStore(expected.failure);
    const service = new ControlPlaneService({
      runs: store,
      events: store,
      queue: new InMemoryRunQueue(),
      reviews: new InMemoryHumanReviewGateway(),
    });
    const server = createServer(createControlPlaneHttpHandler(service));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/v1/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "infra-failure",
          "X-Organisation-Id": "org",
          "X-Project-Id": "project",
        },
        body: JSON.stringify({
          task: "retry safely",
          idempotencyKey: "infra-failure",
          projectRef: "project://opaque",
          baselineRevisionRef: "git://baseline",
        }),
      });
      assert.equal(response.status, expected.status);
      const body = (await response.json()) as {
        readonly error: {
          readonly code: string;
          readonly retryable: boolean;
        };
      };
      assert.equal(body.error.code, expected.code);
      assert.equal(body.error.retryable, true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  }
});
