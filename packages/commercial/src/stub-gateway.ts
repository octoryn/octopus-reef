import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BedrockProvider, type CompletionRequest } from "@octopus-reef/agent";
import { TEST_GATEWAY_LICENSE_TOKEN } from "./index.js";

export interface StubGatewayOptions {
  readonly licenseToken?: string;
  readonly bedrockToken?: string;
  readonly model?: string;
  readonly region?: string;
}

export interface StubGateway {
  readonly url: string;
  close(): Promise<void>;
}

export async function startStubGateway(
  options: StubGatewayOptions = {},
): Promise<StubGateway> {
  const licenseToken = options.licenseToken ?? TEST_GATEWAY_LICENSE_TOKEN;
  const server = createServer((req, res) => {
    void handle(req, res, { ...options, licenseToken }).catch((err: unknown) => {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<StubGatewayOptions, "licenseToken">> &
    StubGatewayOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, mode: "reef-gateway-stub" });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/completions") {
    return json(res, 404, { error: "not found" });
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${options.licenseToken}`) {
    return json(res, 403, { error: "invalid Reef test license" });
  }
  const body = (await readJson(req)) as {
    readonly model?: unknown;
    readonly request?: unknown;
  };
  const request = body.request as CompletionRequest | undefined;
  if (request === undefined || typeof request !== "object") {
    return json(res, 400, { error: "request is required" });
  }

  const bedrockToken = options.bedrockToken ?? process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (bedrockToken !== undefined && bedrockToken.trim() !== "") {
    const provider = new BedrockProvider({
      token: bedrockToken,
      ...(typeof body.model === "string" ? { model: body.model } : {}),
      ...(options.region !== undefined ? { region: options.region } : {}),
    });
    return json(res, 200, await provider.complete(request));
  }

  return json(res, 200, {
    content: [
      {
        type: "tool_use",
        id: "reef-gateway-stub-done",
        name: "done",
        input: { summary: "gateway stub completed offline" },
      },
    ],
    stopReason: "tool_use",
    usage: {
      provider: "reef-gateway",
      model: typeof body.model === "string" ? body.model : "reef-gateway-stub",
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
    },
  });
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.length > 128 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw.trim() === "" ? {} : JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
