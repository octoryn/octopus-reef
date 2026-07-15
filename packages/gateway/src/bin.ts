#!/usr/bin/env node
import {
  GatewayControlPlane,
  GatewayHttpServer,
  createGatewayDb,
  loadGatewayConfig,
} from "./index.js";

const config = loadGatewayConfig();
const db = createGatewayDb(config.dbUrl);
const control = new GatewayControlPlane({ config, db });
const server = new GatewayHttpServer(control);

const port = await server.listen();
process.stdout.write(
  JSON.stringify({
    service: "reef-gateway",
    listening: `http://${config.host}:${port}`,
    db: config.dbUrl.startsWith("sqlite:") ? "sqlite" : "postgres",
    jwtSecretSource: config.jwtSecretSource,
  }) + "\n",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
