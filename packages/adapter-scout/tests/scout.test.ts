/**
 * M6 (Scout) — Reef calls a running Scout over HTTP. A fake Scout (injected
 * fetch) proves the client speaks the right protocol: the governed /scrape is
 * mapped to a page, auth is sent, and a non-ok response throws — all without a
 * real ingestion service.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ScoutClient } from "../src/index.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake Scout: records calls, replies per a route map. */
function fakeScout(routes: Record<string, { status: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    calls.push({
      url: input,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body:
        init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    });
    const r = routes[path] ?? { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? "OK" : "ERR",
      json: async () => r.json,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("scout client: health reflects GET /health", async () => {
  const up = fakeScout({ "/health": { status: 200, json: { ok: true } } });
  assert.equal(
    await new ScoutClient({
      baseUrl: "http://scout:8787",
      fetch: up.fetchImpl,
    }).health(),
    true,
  );
  const down = fakeScout({ "/health": { status: 503 } });
  assert.equal(
    await new ScoutClient({
      baseUrl: "http://scout:8787",
      fetch: down.fetchImpl,
    }).health(),
    false,
  );
});

test("scout client: scrape maps the governed result to a page, sends auth", async () => {
  const { fetchImpl, calls } = fakeScout({
    "/scrape": {
      status: 200,
      json: {
        request: { url: "https://example.com" },
        fetch: {
          url: "https://example.com",
          finalUrl: "https://example.com/",
          ok: true,
          status: 200,
          contentType: "text/html",
          fetchedAt: "2026-07-07T00:00:00.000Z",
        },
        markdown: "# Example\n\ntrusted content",
      },
    },
  });
  const client = new ScoutClient({
    baseUrl: "http://scout:8787/",
    apiKey: "k3y",
    fetch: fetchImpl,
  });
  const page = await client.scrape("https://example.com");

  assert.equal(page.ok, true);
  assert.equal(page.finalUrl, "https://example.com/");
  assert.equal(page.contentType, "text/html");
  assert.match(page.content ?? "", /trusted content/);

  // right request: POST /scrape, json body with url + render, bearer auth
  assert.equal(calls[0]!.method, "POST");
  assert.match(calls[0]!.url, /\/scrape$/);
  assert.equal((calls[0]!.body as { url: string }).url, "https://example.com");
  assert.equal((calls[0]!.body as { render: string }).render, "static");
  assert.equal(calls[0]!.headers["authorization"], "Bearer k3y");
});

test("scout client: a non-ok scrape throws", async () => {
  const { fetchImpl } = fakeScout({ "/scrape": { status: 422 } });
  const client = new ScoutClient({
    baseUrl: "http://scout:8787",
    fetch: fetchImpl,
  });
  await assert.rejects(
    () => client.scrape("https://bad"),
    /scout \/scrape failed: 422/,
  );
});
