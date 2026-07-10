import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { GatewayDb } from "./db.js";
import { GatewayLedger } from "./ledger.js";
import type {
  GatewayConfig,
  GatewayDecisionInput,
  GatewayDecisionRecord,
  GatewayErrorBody,
  GatewayVerifyResult,
} from "./types.js";

export interface GatewayControlPlaneOptions {
  readonly config: GatewayConfig;
  readonly db: GatewayDb;
}

export class GatewayControlPlane {
  readonly config: GatewayConfig;
  readonly db: GatewayDb;
  readonly ledger: GatewayLedger;

  constructor(options: GatewayControlPlaneOptions) {
    this.config = options.config;
    this.db = options.db;
    this.ledger = new GatewayLedger({
      db: options.db,
      ...(options.config.ledgerSecret !== undefined
        ? { integritySecret: options.config.ledgerSecret }
        : {}),
    });
  }

  async start(): Promise<void> {
    await this.db.migrate();
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  recordDecision(input: GatewayDecisionInput): Promise<GatewayDecisionRecord> {
    return this.ledger.appendDecision(input);
  }

  verify(): Promise<GatewayVerifyResult> {
    return this.ledger.verify();
  }
}

export class GatewayHttpServer {
  readonly #control: GatewayControlPlane;
  readonly #server: Server;

  constructor(control: GatewayControlPlane) {
    this.#control = control;
    this.#server = createServer((req, res) => {
      void this.#route(req, res).catch((error: unknown) => {
        respondJson(res, statusOf(error), { error: messageOf(error) });
      });
    });
  }

  async listen(port = this.#control.config.port, host = this.#control.config.host): Promise<number> {
    await this.#control.start();
    return new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        const address = this.#server.address();
        resolve(typeof address === "object" && address !== null ? address.port : port);
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      });
    });
    await this.#control.close();
  }

  async #route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      return respondJson(res, 200, {
        ok: true,
        service: "reef-gateway",
        jwtSecretSource: this.#control.config.jwtSecretSource,
      });
    }
    if (req.method === "GET" && url.pathname === "/ready") {
      const verify = await this.#control.verify();
      return respondJson(res, verify.ok ? 200 : 503, {
        ok: verify.ok,
        db: true,
        ledger: verify,
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/verify") {
      const verify = await this.#control.verify();
      return respondJson(res, 200, verify);
    }
    if (req.method === "POST" && url.pathname === "/v1/admin/decisions") {
      const denied = this.#requireAdmin(req);
      if (denied !== undefined) return respondJson(res, 403, denied);
      const body = await readJson(req);
      const decision = parseDecision(body);
      const record = await this.#control.recordDecision(decision);
      return respondJson(res, 201, record);
    }
    return respondJson(res, 404, { error: "not found" });
  }

  #requireAdmin(req: IncomingMessage): GatewayErrorBody | undefined {
    const configured = this.#control.config.adminToken;
    if (configured === undefined) {
      return { error: "admin endpoints are disabled" };
    }
    return req.headers.authorization === `Bearer ${configured}`
      ? undefined
      : { error: "admin token denied" };
  }
}

function parseDecision(value: unknown): GatewayDecisionInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON object body is required");
  }
  const body = value as Record<string, unknown>;
  const decision = clean(body.decision);
  const method = clean(body.method) ?? "admin";
  const tenantId = clean(body.tenantId);
  const accountId = clean(body.accountId);
  const actorId = clean(body.actorId);
  if (decision === undefined) {
    throw new HttpError(400, "decision is required");
  }
  return {
    decision,
    method,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    content: jsonValue(body.content ?? { note: "admin decision recorded" }),
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 128 * 1024) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function respondJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function clean(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function jsonValue(value: unknown): GatewayDecisionInput["content"] {
  return JSON.parse(JSON.stringify(value)) as GatewayDecisionInput["content"];
}

function messageOf(error: unknown): string {
  if (error instanceof HttpError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function statusOf(error: unknown): number {
  return error instanceof HttpError ? error.status : 500;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
