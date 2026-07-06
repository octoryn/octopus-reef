/**
 * MockDriver — a deterministic, offline agent driver.
 *
 * It turns a task into a plausible sequence of governed steps with no LLM call.
 * This is what powers the test suite and the keyless Docker demo: the entire
 * governance substrate (workstate + evidence + gate + replay) is exercised
 * end-to-end without a network or an API key. The real Claude Agent SDK driver
 * implements the identical {@link Driver} interface (see docs/DELIVERY-PLAN.md).
 */
import type { Driver, DriverContext, DriverStep } from "./types.js";

export class MockDriver implements Driver {
  readonly name = "mock";

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    const task = ctx.task;
    yield {
      type: "observe",
      summary: `scanned workspace for context on "${task}"`,
      data: { filesRead: 5 },
    };
    yield {
      type: "message",
      text: `Plan: break "${task}" into an edit, a test run, and a PR.`,
    };
    yield {
      type: "action",
      action: {
        type: "edit",
        summary: `apply change for "${task}"`,
        target: "src/index.ts",
      },
    };
    yield {
      type: "action",
      action: {
        type: "command",
        summary: "run the test suite",
        payload: { command: "npm test" },
      },
    };
    yield {
      type: "action",
      action: {
        type: "pr",
        summary: `open a PR for "${task}"`,
        target: "octopus/reef",
      },
    };
    yield { type: "done", summary: `completed "${task}"` };
  }
}

/**
 * A driver that proposes a dangerous command, to demonstrate the gate denying
 * it in a governed session. Used by tests and the `--demo-denial` CLI flag.
 */
export class UnsafeDemoDriver implements Driver {
  readonly name = "unsafe-demo";

  async *run(ctx: DriverContext): AsyncIterable<DriverStep> {
    yield { type: "observe", summary: `looked at "${ctx.task}"` };
    yield {
      type: "action",
      action: {
        type: "command",
        summary: "clean the machine",
        payload: { command: "rm -rf /" },
        required: true,
      },
    };
    yield { type: "done", summary: "attempted cleanup" };
  }
}
