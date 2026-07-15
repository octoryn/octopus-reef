import { createServer, type ServerResponse } from "node:http";
import { stubIdToken } from "./team-sso.js";

export interface StubIdentityProviderOptions {
  readonly userId?: string;
  readonly displayName?: string;
  readonly licenseToken?: string;
}

export interface StubIdentityProvider {
  readonly issuer: string;
  close(): Promise<void>;
}

/** A loopback-only OIDC discovery and token stub for offline acceptance runs. */
export async function startStubIdentityProvider(
  options: StubIdentityProviderOptions = {},
): Promise<StubIdentityProvider> {
  let issuer = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
    if (
      req.method === "GET" &&
      url.pathname === "/.well-known/openid-configuration"
    ) {
      return json(res, 200, {
        issuer,
        token_endpoint: `${issuer}/token`,
        grant_types_supported: ["authorization_code"],
      });
    }
    if (req.method === "POST" && url.pathname === "/token") {
      return json(res, 200, {
        token_type: "Bearer",
        id_token: stubIdToken(options),
      });
    }
    return json(res, 404, { error: "not found" });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address !== null ? address.port : 0,
      );
    });
  });
  issuer = `http://127.0.0.1:${port}`;
  return {
    issuer,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
