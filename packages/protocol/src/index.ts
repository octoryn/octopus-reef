/**
 * @octopus-reef/protocol — the Reef wire contract.
 *
 * One governed backend, many surfaces (CLI, IDE, Web). This package is the
 * shared, transport-agnostic vocabulary they exchange: how a session is created,
 * how its live evidence stream is framed, and how a client re-verifies it
 * store-untrusting over the wire. It re-exports the engine's own value types so a
 * client renders exactly what the engine recorded — no parallel, drifting shapes.
 *
 * The reference transport (see `@octopus-reef/server`) is plain HTTP + SSE: a
 * client POSTs to act and subscribes to a Server-Sent-Events stream to observe.
 * Nothing here assumes that, though — the same envelopes ride any transport.
 */
import type {
  ReefEvent,
  SessionOutcome,
  SessionSnapshot,
} from "@octopus-reef/engine";

export type { ReefEvent, SessionOutcome, SessionSnapshot };

/** Bumped when the wire shapes below change incompatibly. */
export const REEF_PROTOCOL_VERSION = "0.1.0";

/** The result of a store-untrusting verification, carried over the wire. */
export interface VerifyResult {
  /** Every check passed: the session is provable. */
  readonly ok: boolean;
  /** Work-spine integrity: `intact` | `tampered` | `<reason>`. */
  readonly work: string;
  /** Evidence-log integrity: `intact` | `tampered` | `<reason>`. */
  readonly log: string;
  /** Spine↔log cross-binding: `bound` | `unbound` | `<reason>`. */
  readonly binding: string;
}

/** `POST /sessions` — start a governed session. */
export interface CreateSessionRequest {
  readonly task: string;
  /** Keyed mode: the server binds every link with this HMAC (never echoed back). */
  readonly secret?: string;
  /** Persist the session to disk on the server as it seals. */
  readonly persist?: boolean;
  /** Workspace root for real governed edit/test runs. Omitted for the mock demo. */
  readonly workspaceRoot?: string;
  /** BYOK model settings. If absent or keyless, the daemon falls back to MockDriver. */
  readonly model?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly name?: string;
  };
  /**
   * N5 offline MCP proof path. When present, the daemon uses an explicit
   * deterministic driver that calls the named MCP tool through the governed
   * `tool` action path. This does not require an LLM key.
   */
  readonly mcp?: {
    readonly serverId?: string;
    readonly tool?: string;
    readonly input?: unknown;
    readonly expectDenied?: boolean;
  };
}

/** `POST /sessions` response. */
export interface CreateSessionResponse {
  readonly id: string;
}

/** How far a session has progressed, for `GET /sessions/:id`. */
export type SessionStatus = "running" | "sealed";

/** `GET /sessions/:id` — a point-in-time view of a session. */
export interface SessionView {
  readonly id: string;
  readonly task: string;
  readonly status: SessionStatus;
  readonly outcome: SessionOutcome | null;
  /** Present once the session has sealed. */
  readonly snapshot: SessionSnapshot | null;
  /** Present once the session has sealed. */
  readonly verify: VerifyResult | null;
  /** Events emitted so far (also streamed live via the SSE endpoint). */
  readonly events: number;
}

/**
 * A frame on the `GET /sessions/:id/events` SSE stream. A subscriber always
 * receives `hello`, then every `event` in order (buffered ones replayed first,
 * so a late subscriber still sees the whole session), then a terminal `sealed`
 * carrying the final snapshot + verdict.
 */
export type ServerEvent =
  | { readonly type: "hello"; readonly id: string; readonly task: string }
  | { readonly type: "event"; readonly event: ReefEvent }
  | {
      readonly type: "sealed";
      readonly snapshot: SessionSnapshot;
      readonly verify: VerifyResult;
    };

/** An error body returned by the server (non-2xx responses). */
export interface ErrorResponse {
  readonly error: string;
}
