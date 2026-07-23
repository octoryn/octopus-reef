#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import {
  createGoldenStackProfile,
  defineTrustedProfile,
} from "../packages/verification/dist/index.js";

const [imageDigest, output = "golden-profile.json"] = process.argv.slice(2);
if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest ?? "")) {
  throw new Error("an immutable remote sandbox manifest digest is required");
}

const original = createGoldenStackProfile(imageDigest);
const { digest: _originalDigest, ...unsigned } = original;
const profile = defineTrustedProfile({
  ...unsigned,
  version: "1.0.2",
});
writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o644,
});
