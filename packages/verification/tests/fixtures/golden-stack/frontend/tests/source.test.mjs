import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

test("generated frontend exposes its deterministic marker and health route", async () => {
  const page = await readFile(new URL("../app/page.jsx", import.meta.url), "utf8");
  const health = await readFile(new URL("../app/api/health/route.js", import.meta.url), "utf8");
  assert.match(page, /data-verification="golden-stack"/);
  assert.match(health, /component: "frontend"/);
});
