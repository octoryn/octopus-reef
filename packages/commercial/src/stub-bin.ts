#!/usr/bin/env node
import { startStubGateway } from "./stub-gateway.js";
import { TEST_GATEWAY_LICENSE_TOKEN } from "./index.js";

const gateway = await startStubGateway({
  licenseToken:
    process.env.REEF_TEST_LICENSE_TOKEN ?? TEST_GATEWAY_LICENSE_TOKEN,
});

process.stdout.write(`reef gateway stub listening on ${gateway.url}\n`);

const stop = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
