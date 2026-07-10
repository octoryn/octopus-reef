import type {
  GatewayLedgerAnchor,
  StoredLedgerRecord,
} from "./types.js";

export interface GatewayDb {
  migrate(): Promise<void>;
  appendLedgerRecord(record: StoredLedgerRecord): Promise<void>;
  listLedgerRecords(): Promise<readonly StoredLedgerRecord[]>;
  readLedgerAnchor(): Promise<GatewayLedgerAnchor | undefined>;
  writeLedgerAnchor(anchor: GatewayLedgerAnchor): Promise<void>;
  close(): Promise<void>;
}
