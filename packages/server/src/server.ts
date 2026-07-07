/**
 * ReefServer — one governed-session backend, over plain HTTP + SSE.
 *
 * The surfaces (CLI, IDE, Web) are thin; the governance lives in the engine, and
 * this daemon simply hosts it and streams what it records. A client:
 *   POST /sessions            → start a governed session, get its id
 *   GET  /sessions/:id        → a point-in-time view (snapshot + verdict)
 *   GET  /sessions/:id/events → the live evidence stream (Server-Sent Events)
 *   GET  /sessions/:id/verify → re-verify store-untrusting, over the wire
 *   GET  /health              → liveness
 *
 * The event stream replays every buffered event before live-tailing, so a client
 * that connects late still observes the whole session in order — which is what
 * lets two independent clients watch one live session and both verify it.
 *
 * SSE (not WebSocket) is deliberate: it needs no dependency, works in browsers
 * (`EventSource`), Node, and editors alike, and a governed tool minimises its
 * supply chain. Clients act via POST and observe via the stream.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import {
  GovernedSession,
  MockDriver,
  persistSession,
  type Driver,
  type ReefEvent,
  type SessionOutcome,
  type SessionSnapshot,
} from "@octopus-reef/engine";
import type {
  CreateSessionRequest,
  ServerEvent,
  SessionView,
  VerifyResult,
} from "@octopus-reef/protocol";

interface SessionRecord {
  readonly id: string;
  readonly task: string;
  session: GovernedSession;
  readonly events: ReefEvent[];
  readonly subscribers: Set<ServerResponse>;
  status: "running" | "sealed";
  snapshot: SessionSnapshot | null;
  verify: VerifyResult | null;
  outcome: SessionOutcome | null;
}

export interface ReefServerOptions {
  /** Persist each session to `<dir>/<id>` as it seals. */
  readonly persistDir?: string;
  /**
   * Build the driver for a session. Defaults to the offline {@link MockDriver},
   * so the server runs keyless out of the box (Docker demo, tests). A deployment
   * swaps in a real agent driver here.
   */
  readonly driverFactory?: (task: string) => Driver;
}

const MAX_BODY = 64 * 1024;

/** A local daemon hosting the Reef engine for every surface to share. */
export class ReefServer {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #options: ReefServerOptions;
  readonly #http: Server;
  #counter = 0;

  constructor(options: ReefServerOptions = {}) {
    this.#options = options;
    this.#http = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        this.#fail(res, 500, err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** Start listening. Pass 0 for an ephemeral port; resolves with the bound port. */
  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.#http.once("error", reject);
      this.#http.listen(port, host, () => {
        const addr = this.#http.address();
        resolve(typeof addr === "object" && addr !== null ? addr.port : port);
      });
    });
  }

  /** Stop listening and end every open stream. */
  close(): Promise<void> {
    for (const rec of this.#sessions.values()) {
      for (const res of rec.subscribers) res.end();
      rec.subscribers.clear();
    }
    return new Promise((resolve) => this.#http.close(() => resolve()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";

    if (method === "GET" && parts.length === 1 && parts[0] === "health") {
      return this.#json(res, 200, { ok: true });
    }
    if (method === "POST" && parts.length === 1 && parts[0] === "sessions") {
      return this.#createSession(req, res);
    }
    if (parts[0] === "sessions" && parts.length >= 2) {
      const rec = this.#sessions.get(parts[1]!);
      if (rec === undefined) return this.#fail(res, 404, "unknown session");
      if (method === "GET" && parts.length === 2) {
        return this.#json(res, 200, this.#view(rec));
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "events") {
        return this.#subscribe(req, res, rec);
      }
      if (method === "GET" && parts.length === 3 && parts[2] === "verify") {
        return this.#verify(res, rec);
      }
    }
    this.#fail(res, 404, "not found");
  }

  async #createSession(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: CreateSessionRequest;
    try {
      body = (await this.#readJson(req)) as CreateSessionRequest;
    } catch (err) {
      return this.#fail(
        res,
        400,
        err instanceof Error ? err.message : "bad body",
      );
    }
    const task = typeof body.task === "string" ? body.task.trim() : "";
    if (task === "") return this.#fail(res, 400, "task is required");

    const id = `sess-${(this.#counter++).toString(36)}-${Date.now().toString(36)}`;
    const driver = this.#options.driverFactory?.(task) ?? new MockDriver();
    const rec: SessionRecord = {
      id,
      task,
      session: undefined as unknown as GovernedSession,
      events: [],
      subscribers: new Set(),
      status: "running",
      snapshot: null,
      verify: null,
      outcome: null,
    };
    rec.session = new GovernedSession({
      id,
      task,
      driver,
      ...(typeof body.secret === "string" && body.secret.length > 0
        ? { integritySecret: body.secret }
        : {}),
      onEvent: (event) => {
        rec.events.push(event);
        this.#broadcast(rec, { type: "event", event });
      },
    });
    this.#sessions.set(id, rec);
    void this.#run(rec, body.persist === true);
    this.#json(res, 201, { id });
  }

  async #run(rec: SessionRecord, persist: boolean): Promise<void> {
    try {
      const result = await rec.session.run();
      rec.snapshot = result.snapshot;
      rec.outcome = result.outcome;
    } catch {
      rec.outcome = "failed";
    }
    rec.verify = rec.session.verify();
    rec.status = "sealed";
    if (persist && this.#options.persistDir !== undefined) {
      try {
        persistSession(rec.session, join(this.#options.persistDir, rec.id));
      } catch {
        /* persistence is best-effort; the live session still verifies */
      }
    }
    if (rec.snapshot !== null) {
      this.#broadcast(rec, {
        type: "sealed",
        snapshot: rec.snapshot,
        verify: rec.verify,
      });
    }
    for (const res of rec.subscribers) res.end();
    rec.subscribers.clear();
  }

  #subscribe(
    req: IncomingMessage,
    res: ServerResponse,
    rec: SessionRecord,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    // No `await` below this point: the handler runs to completion atomically, so
    // no live event can interleave between the replay and the subscription.
    this.#send(res, { type: "hello", id: rec.id, task: rec.task });
    for (const event of rec.events) this.#send(res, { type: "event", event });
    if (rec.status === "sealed") {
      if (rec.snapshot !== null && rec.verify !== null) {
        this.#send(res, {
          type: "sealed",
          snapshot: rec.snapshot,
          verify: rec.verify,
        });
      }
      res.end();
      return;
    }
    rec.subscribers.add(res);
    req.on("close", () => rec.subscribers.delete(res));
  }

  #verify(res: ServerResponse, rec: SessionRecord): void {
    if (rec.status !== "sealed") {
      this.#fail(res, 409, "session has not sealed yet");
      return;
    }
    // Re-verify from scratch — store-untrusting, exactly as an offline auditor would.
    this.#json(res, 200, rec.session.verify());
  }

  #view(rec: SessionRecord): SessionView {
    return {
      id: rec.id,
      task: rec.task,
      status: rec.status,
      outcome: rec.outcome,
      snapshot: rec.snapshot,
      verify: rec.verify,
      events: rec.events.length,
    };
  }

  #broadcast(rec: SessionRecord, frame: ServerEvent): void {
    for (const res of rec.subscribers) this.#send(res, frame);
  }

  #send(res: ServerResponse, frame: ServerEvent): void {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(payload);
  }

  #fail(res: ServerResponse, status: number, error: string): void {
    if (!res.headersSent) this.#json(res, status, { error });
    else res.end();
  }

  #readJson(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
        if (raw.length > MAX_BODY) {
          reject(new Error("request body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (raw.trim() === "") return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }
}
