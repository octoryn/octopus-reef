#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGoldenStackProfile } from "../packages/verification/dist/golden-profile.js";

const [imageDigest, output] = process.argv.slice(2);
if (imageDigest === undefined || output === undefined) {
  throw new Error(
    "usage: write-verification-golden-profile.mjs <sha256:image-digest> <output.json>",
  );
}

const target = resolve(output);
const profile = createGoldenStackProfile(imageDigest);
writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
