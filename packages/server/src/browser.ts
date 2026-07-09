import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import type { JsonValue } from "octopus-evidence";
import type {
  ActionResult,
  Driver,
  DriverContext,
  DriverStep,
  Tool,
} from "@octopus-reef/engine";

type BrowserToolName =
  | "browser.navigate"
  | "browser.getDom"
  | "browser.getContent"
  | "browser.screenshot";

interface WebSocketEvent {
  readonly data: unknown;
}

interface WebSocketLike {
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: WebSocketEvent) => void,
    options?: { once?: boolean },
  ): void;
  send(data: string): void;
  close(): void;
}

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string; readonly data?: unknown };
}

interface CdpTarget {
  readonly type?: string;
  readonly webSocketDebuggerUrl?: string;
}

const BROWSER_TOOLS: readonly BrowserToolName[] = [
  "browser.navigate",
  "browser.getDom",
  "browser.getContent",
  "browser.screenshot",
];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
].filter((value): value is string => typeof value === "string" && value !== "");

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function localUrl(raw: unknown): string {
  const text = optionalString(raw);
  if (text === undefined) throw new Error("browser tool requires a URL");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`invalid browser URL: ${text}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      "browser navigation only permits http/https localhost URLs",
    );
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `browser navigation denied for non-local host: ${parsed.hostname}`,
    );
  }
  return parsed.href;
}

function summarizeBase64(data: string): {
  readonly bytes: number;
  readonly sha256: string;
} {
  const bytes = Buffer.byteLength(data, "base64");
  return {
    bytes,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        resolve(
          typeof address === "object" && address !== null ? address.port : 0,
        ),
      );
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  readonly #ws: WebSocketLike;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  readonly #handlers = new Map<string, Array<(params: unknown) => void>>();

  private constructor(ws: WebSocketLike) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#message(event));
  }

  static async connect(url: string): Promise<CdpClient> {
    const ctor = (
      globalThis as unknown as {
        WebSocket?: new (url: string) => WebSocketLike;
      }
    ).WebSocket;
    if (ctor === undefined) throw new Error("Node WebSocket is unavailable");
    const ws = new ctor(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error("CDP WebSocket failed to open")),
        { once: true },
      );
    });
    return new CdpClient(ws);
  }

  on(method: string, handler: (params: unknown) => void): () => void {
    const list = this.#handlers.get(method) ?? [];
    list.push(handler);
    this.#handlers.set(method, list);
    return () => {
      const current = this.#handlers.get(method) ?? [];
      this.#handlers.set(
        method,
        current.filter((candidate) => candidate !== handler),
      );
    };
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId++;
    const message = { id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout for ${method}`));
      }, 15_000);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#ws.send(JSON.stringify(message));
    return promise;
  }

  waitFor(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let off = (): void => {};
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event timeout for ${method}`));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP client closed"));
    }
    this.#pending.clear();
    this.#ws.close();
  }

  #message(event: WebSocketEvent): void {
    const raw =
      typeof event.data === "string"
        ? event.data
        : Buffer.isBuffer(event.data)
          ? event.data.toString("utf8")
          : "";
    if (raw === "") return;
    const message = JSON.parse(raw) as CdpMessage;
    if (message.id !== undefined && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)!;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `${message.error.message ?? "CDP error"}: ${String(
              message.error.data ?? "",
            )}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method !== undefined) {
      for (const handler of this.#handlers.get(message.method) ?? []) {
        handler(message.params);
      }
    }
  }
}

export class BrowserPowerRuntime {
  readonly #initialUrl: string | undefined;
  #child: ChildProcess | undefined;
  #profileDir: string | undefined;
  #port: number | undefined;
  #cdp: CdpClient | undefined;
  #currentUrl = "about:blank";

  constructor(initialUrl?: string) {
    this.#initialUrl =
      initialUrl === undefined ? undefined : localUrl(initialUrl);
  }

  allowedTools(): BrowserToolName[] {
    return [...BROWSER_TOOLS];
  }

  tools(): Tool[] {
    return [
      {
        name: "browser.navigate",
        description:
          "Navigate the local Reef browser to a user-supplied localhost URL.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
          additionalProperties: false,
        },
        run: (input) => this.#navigate(input),
      },
      {
        name: "browser.getDom",
        description:
          "Read the current page DOM or one selected element through local Chrome CDP.",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          additionalProperties: false,
        },
        run: (input) => this.#getDom(input),
      },
      {
        name: "browser.getContent",
        description:
          "Read rendered page text or one selected element's text through local Chrome CDP.",
        inputSchema: {
          type: "object",
          properties: { selector: { type: "string" } },
          additionalProperties: false,
        },
        run: (input) => this.#getContent(input),
      },
      {
        name: "browser.screenshot",
        description:
          "Capture a PNG screenshot of the current local browser page through CDP.",
        inputSchema: { type: "object", additionalProperties: false },
        run: () => this.#screenshot(),
      },
    ];
  }

  close(): void {
    this.#cdp?.close();
    this.#cdp = undefined;
    this.#child?.kill("SIGKILL");
    this.#child = undefined;
    if (this.#profileDir !== undefined) {
      try {
        rmSync(this.#profileDir, {
          recursive: true,
          force: true,
          maxRetries: 50,
          retryDelay: 100,
        });
      } catch {
        /* Chrome can leave profile files briefly locked after CDP shutdown. */
      }
      this.#profileDir = undefined;
    }
  }

  async #navigate(input: JsonValue) {
    const body = jsonObject(input);
    const url = localUrl(body.url);
    const cdp = await this.#ensure();
    const loaded = cdp.waitFor("Page.loadEventFired", 10_000).catch(() => null);
    await cdp.send("Page.navigate", { url });
    await loaded;
    await sleep(250);
    this.#currentUrl = url;
    const title = await this.#evaluateString("document.title || ''");
    return {
      ok: true,
      output: JSON.stringify({ url, title }),
    };
  }

  async #getDom(input: JsonValue) {
    await this.#ensureAtInitialUrl();
    const selector = optionalString(jsonObject(input).selector);
    const expression =
      selector === undefined
        ? "document.documentElement ? document.documentElement.outerHTML : ''"
        : `(() => { const node = document.querySelector(${JSON.stringify(
            selector,
          )}); return node ? node.outerHTML : ''; })()`;
    const html = await this.#evaluateString(expression);
    return {
      ok: true,
      output: JSON.stringify({
        url: this.#currentUrl,
        ...(selector !== undefined ? { selector } : {}),
        html,
      }),
    };
  }

  async #getContent(input: JsonValue) {
    await this.#ensureAtInitialUrl();
    const selector = optionalString(jsonObject(input).selector);
    const expression =
      selector === undefined
        ? "document.body ? document.body.innerText : ''"
        : `(() => { const node = document.querySelector(${JSON.stringify(
            selector,
          )}); return node ? node.innerText : ''; })()`;
    const text = await this.#evaluateString(expression);
    return {
      ok: true,
      output: JSON.stringify({
        url: this.#currentUrl,
        ...(selector !== undefined ? { selector } : {}),
        text,
      }),
    };
  }

  async #screenshot() {
    await this.#ensureAtInitialUrl();
    const cdp = await this.#ensure();
    const result = jsonObject(
      await cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
    );
    const data = typeof result.data === "string" ? result.data : "";
    return {
      ok: true,
      output: JSON.stringify({
        url: this.#currentUrl,
        mime: "image/png",
        base64: data,
        ...summarizeBase64(data),
      }),
    };
  }

  async #ensureAtInitialUrl(): Promise<void> {
    await this.#ensure();
    if (this.#initialUrl !== undefined && this.#currentUrl === "about:blank") {
      await this.#navigate({ url: this.#initialUrl });
    }
  }

  async #ensure(): Promise<CdpClient> {
    if (this.#cdp !== undefined) return this.#cdp;
    const chrome = CHROME_PATHS[0];
    if (chrome === undefined) {
      throw new Error("Google Chrome was not found for CDP browser tools");
    }
    this.#port = await freePort();
    this.#profileDir = mkdtempSync(join(tmpdir(), "reef-browser-"));
    this.#child = spawn(
      chrome,
      [
        `--remote-debugging-port=${this.#port}`,
        `--user-data-dir=${this.#profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-features=Translate,MediaRouter",
        "--window-size=1280,900",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const target = await this.#waitForPageTarget();
    this.#cdp = await CdpClient.connect(target.webSocketDebuggerUrl!);
    await this.#cdp.send("Page.enable");
    await this.#cdp.send("Runtime.enable");
    return this.#cdp;
  }

  async #waitForPageTarget(): Promise<CdpTarget> {
    const port = this.#port;
    if (port === undefined)
      throw new Error("Chrome CDP port was not allocated");
    const deadline = Date.now() + 15_000;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (response.ok) {
          const targets = (await response.json()) as CdpTarget[];
          const page = targets.find(
            (target) =>
              target.type === "page" &&
              typeof target.webSocketDebuggerUrl === "string",
          );
          if (page !== undefined) return page;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      await sleep(250);
    }
    throw new Error(`timed out waiting for Chrome CDP page: ${lastError}`);
  }

  async #evaluateString(expression: string): Promise<string> {
    const cdp = await this.#ensure();
    const result = jsonObject(
      await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    );
    const value = jsonObject(result.result).value;
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }
}

export class BrowserDemoDriver implements Driver {
  readonly name = "browser-demo";
  readonly #url: string | undefined;
  readonly #tool: BrowserToolName | undefined;
  readonly #selector: string | undefined;
  readonly #expectDenied: boolean;

  constructor(options: {
    readonly url?: string;
    readonly tool?: string;
    readonly selector?: string;
    readonly expectDenied?: boolean;
  }) {
    this.#url = options.url === undefined ? undefined : localUrl(options.url);
    this.#tool = BROWSER_TOOLS.includes(options.tool as BrowserToolName)
      ? (options.tool as BrowserToolName)
      : undefined;
    this.#selector = options.selector;
    this.#expectDenied = options.expectDenied === true;
  }

  async *run(
    _ctx: DriverContext,
  ): AsyncGenerator<DriverStep, void, ActionResult | undefined> {
    const requestedTools =
      this.#tool !== undefined
        ? [this.#tool]
        : ([
            "browser.navigate",
            "browser.getDom",
            "browser.getContent",
            "browser.screenshot",
          ] satisfies readonly BrowserToolName[]);
    yield {
      type: "observe" as const,
      summary: "resolved governed browser power",
      data: {
        tools: requestedTools,
        ...(this.#url !== undefined ? { url: this.#url } : {}),
        expectDenied: this.#expectDenied,
      },
    };

    for (const tool of requestedTools) {
      const input =
        tool === "browser.navigate"
          ? { url: this.#url ?? "http://127.0.0.1:9/" }
          : this.#selector !== undefined
            ? { selector: this.#selector }
            : {};
      const result = yield {
        type: "action" as const,
        action: {
          type: "tool" as const,
          summary: `Browser tool call: ${tool}`,
          target: tool,
          payload: { tool, input },
          required: !this.#expectDenied,
        },
      };

      if (this.#expectDenied) {
        if (
          typeof result === "object" &&
          result !== null &&
          "allowed" in result &&
          result.allowed === false
        ) {
          yield {
            type: "done" as const,
            summary: `denied unallowlisted browser tool ${tool}`,
          };
          return;
        }
        yield {
          type: "fail" as const,
          summary: `expected browser tool ${tool} to be denied`,
        };
        return;
      }

      if (
        typeof result === "object" &&
        result !== null &&
        result.executed === true &&
        result.error === undefined
      ) {
        yield {
          type: "observe" as const,
          summary: `Browser tool ${tool} returned`,
          data: {
            tool,
            outputBytes:
              "output" in result && typeof result.output === "string"
                ? result.output.length
                : 0,
          },
        };
        continue;
      }

      yield {
        type: "fail" as const,
        summary: `browser tool ${tool} did not execute`,
      };
      return;
    }
    yield { type: "done" as const, summary: "read page through browser power" };
  }
}
