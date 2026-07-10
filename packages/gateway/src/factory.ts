import { dbDriverFor, sqliteLocationFromUrl } from "./config.js";
import type { GatewayDb } from "./db.js";
import { PostgresGatewayDb } from "./postgres.js";
import { SqliteGatewayDb } from "./sqlite.js";

export function createGatewayDb(dbUrl: string): GatewayDb {
  const driver = dbDriverFor(dbUrl);
  if (driver === "sqlite") {
    return new SqliteGatewayDb(sqliteLocationFromUrl(dbUrl));
  }
  return new PostgresGatewayDb(dbUrl);
}
