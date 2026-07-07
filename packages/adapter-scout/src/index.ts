/**
 * @octopus-reef/adapter-scout — Reef CALLS Scout, it doesn't bundle it.
 *
 * `octopus-scout` is a full web/PDF ingestion SERVICE (fastify + playwright +
 * postgres + redis) — the wrong thing to embed in a governed session. The right
 * integration is a thin, dependency-free HTTP client: at session open, Reef asks
 * a RUNNING Scout to pull task context (a URL), governed by Scout's own policy
 * (robots, rate-limit, hash-dedup, SSRF guard), and brings the trusted content
 * in as a session observation.
 *
 * `fetch` is injectable so this is testable without a running Scout (and works
 * anywhere global `fetch` exists — Node ≥ 22, browsers).
 */

/** A page pulled through Scout's governed ingestion. */
export interface ScoutPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly ok: boolean;
  readonly status: number;
  readonly contentType: string;
  readonly fetchedAt: string;
  /** Normalized content (Markdown/text), when Scout produced it. */
  readonly content: string | undefined;
}

export interface ScoutClientOptions {
  readonly baseUrl: string;
  /** Bearer/x-api-key credential for a protected Scout. */
  readonly apiKey?: string;
  /** Injectable fetch (defaults to the global). Tests pass a fake Scout here. */
  readonly fetch?: typeof fetch;
}

export interface ScrapeOptions {
  /** `"static"` (fetch) or a browser render mode Scout supports. */
  readonly render?: string;
  readonly respectRobots?: boolean;
  readonly forceRefresh?: boolean;
}

/** Extract the normalized content from a Scout scrape result, best-effort. */
function contentOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of ["markdown", "content", "text"]) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  for (const nest of ["document", "extraction"]) {
    const inner = r[nest];
    if (typeof inner === "object" && inner !== null) {
      const md = (inner as Record<string, unknown>)["markdown"];
      if (typeof md === "string") return md;
    }
  }
  return undefined;
}

/** A thin client for a running octopus-scout service. */
export class ScoutClient {
  readonly #base: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ScoutClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  #headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { "content-type": "application/json" } : {}),
      ...(this.#apiKey !== undefined
        ? { authorization: `Bearer ${this.#apiKey}` }
        : {}),
    };
  }

  /** Is the Scout service up? (`GET /health`) */
  async health(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.#base}/health`, {
        headers: this.#headers(false),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Pull a URL through Scout's governed ingestion pipeline (`POST /scrape`) and
   * return the normalized page. Throws if Scout rejects the request.
   */
  async scrape(url: string, options: ScrapeOptions = {}): Promise<ScoutPage> {
    const res = await this.#fetch(`${this.#base}/scrape`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({ url, render: "static", ...options }),
    });
    if (!res.ok) {
      throw new Error(`scout /scrape failed: ${res.status} ${res.statusText}`);
    }
    const raw: unknown = await res.json();
    const fetchInfo =
      typeof raw === "object" && raw !== null
        ? ((raw as Record<string, unknown>)["fetch"] as
            Record<string, unknown> | undefined)
        : undefined;
    const f = fetchInfo ?? {};
    return {
      url: typeof f["url"] === "string" ? (f["url"] as string) : url,
      finalUrl:
        typeof f["finalUrl"] === "string" ? (f["finalUrl"] as string) : url,
      ok: f["ok"] === true,
      status: typeof f["status"] === "number" ? (f["status"] as number) : 0,
      contentType:
        typeof f["contentType"] === "string"
          ? (f["contentType"] as string)
          : "",
      fetchedAt:
        typeof f["fetchedAt"] === "string" ? (f["fetchedAt"] as string) : "",
      content: contentOf(raw),
    };
  }
}
