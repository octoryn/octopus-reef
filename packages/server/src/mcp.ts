import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JsonValue } from "octopus-evidence";
import type { Tool } from "@octopus-reef/engine";

export type McpTransport =
  | {
      readonly type: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: "http";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface InstalledPower {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly transport: McpTransport;
  readonly tools: readonly McpToolDefinition[];
  readonly allowedTools: readonly string[];
  readonly source: "available" | "custom";
}

export interface AvailablePower {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly transport: "stdio" | "http";
  readonly tools: readonly McpToolDefinition[];
  readonly allowedTools: readonly string[];
}

export interface PowerView {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly source: "available" | "custom";
  readonly transport:
    | {
        readonly type: "stdio";
        readonly command: string;
        readonly args: readonly string[];
      }
    | { readonly type: "http"; readonly url: string };
  readonly tools: readonly McpToolDefinition[];
  readonly allowedTools: readonly string[];
}

export interface PowerList {
  readonly installed: readonly PowerView[];
  readonly available: readonly AvailablePower[];
  readonly host: {
    readonly mode: "reef-managed";
    readonly reason: string;
  };
}

export interface AddCustomPowerRequest {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
  readonly url?: unknown;
  readonly config?: unknown;
  readonly tools?: unknown;
  readonly allowedTools?: unknown;
}

interface StoreFile {
  readonly version: 1;
  readonly installed: readonly InstalledPower[];
}

const ECHO_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "echo",
    description: "Echo text back from a local offline MCP server.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "reverse",
    description: "Reverse text. Present to prove unallowlisted MCP denial.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

const ECHO_MCP_SERVER_SOURCE = String.raw`
const readline = require("node:readline");
const tools = [
  {
    name: "echo",
    description: "Echo text back from a local offline MCP server.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false
    }
  },
  {
    name: "reverse",
    description: "Reverse text. Present to prove unallowlisted MCP denial.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false
    }
  }
];
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function text(args) {
  return args && typeof args.text === "string" ? args.text : "";
}
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;
  try {
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params && message.params.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "reef-echo", version: "0.1.0" }
        }
      });
    } else if (message.method === "tools/list") {
      send({ jsonrpc: "2.0", id: message.id, result: { tools } });
    } else if (message.method === "tools/call") {
      const name = message.params && message.params.name;
      const args = message.params && message.params.arguments || {};
      const value = text(args);
      if (name === "echo") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + value }] } });
      } else if (name === "reverse") {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: value.split("").reverse().join("") }] } });
      } else {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown tool: " + String(name) } });
      }
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found: " + String(message.method) } });
    }
  } catch (error) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error && error.message || String(error) } });
  }
});
`;

const AVAILABLE_POWERS: readonly AvailablePower[] = [
  {
    id: "reef-echo",
    name: "Reef Echo",
    description:
      "A dependency-free local stdio MCP server used for offline governed tool-call proof.",
    transport: "stdio",
    tools: ECHO_TOOLS,
    allowedTools: ["echo"],
  },
];

const REQUEST_TIMEOUT_MS = 8000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((item) => (typeof item === "string" ? item : undefined))
    .filter((item): item is string => item !== undefined);
  return result.length === value.length ? result : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const obj = asObject(value);
  if (obj === undefined) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(obj)) {
    if (typeof item !== "string") return undefined;
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function normalizeTools(value: unknown): McpToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const tools: McpToolDefinition[] = [];
  for (const item of value) {
    const obj = asObject(item);
    const name = optionalString(obj?.name);
    if (name === undefined) continue;
    const description = optionalString(obj?.description);
    const inputSchema = asObject(obj?.inputSchema);
    tools.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
    });
  }
  return tools;
}

function normalizeTransport(input: AddCustomPowerRequest): McpTransport {
  let raw = input.config;
  if (typeof raw === "string" && raw.trim() !== "") {
    raw = JSON.parse(raw) as unknown;
  }
  const config = asObject(raw) ?? (input as Record<string, unknown>);
  const url = optionalString(config.url);
  if (url !== undefined) {
    const headers = stringRecord(config.headers);
    return {
      type: "http",
      url,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  const command = optionalString(config.command);
  if (command === undefined) {
    throw new Error("custom MCP power requires a command or url");
  }
  const args = stringArray(config.args);
  const cwd = optionalString(config.cwd);
  const env = stringRecord(config.env);
  return {
    type: "stdio",
    command,
    ...(args !== undefined ? { args } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
  };
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s === "" ? "custom-power" : s;
}

function mcpToolName(powerId: string, toolName: string): string {
  return `${powerId}.${toolName}`;
}

function availableInstall(id: string): InstalledPower | undefined {
  const available = AVAILABLE_POWERS.find((power) => power.id === id);
  if (available === undefined) return undefined;
  if (available.id === "reef-echo") {
    return {
      id: available.id,
      name: available.name,
      description: available.description,
      source: "available",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: ["-e", ECHO_MCP_SERVER_SOURCE],
      },
      tools: available.tools,
      allowedTools: available.allowedTools,
    };
  }
  return undefined;
}

function view(power: InstalledPower): PowerView {
  return {
    id: power.id,
    name: power.name,
    ...(power.description !== undefined
      ? { description: power.description }
      : {}),
    source: power.source,
    transport:
      power.transport.type === "stdio"
        ? {
            type: "stdio",
            command: power.transport.command,
            args: power.transport.args ?? [],
          }
        : { type: "http", url: power.transport.url },
    tools: power.tools,
    allowedTools: power.allowedTools,
  };
}

class StdioMcpClient {
  readonly #transport: Extract<McpTransport, { type: "stdio" }>;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #stdout = "";
  #stderr = "";
  readonly #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(transport: Extract<McpTransport, { type: "stdio" }>) {
    this.#transport = transport;
  }

  start(): void {
    const env = {
      ...process.env,
      ...(this.#transport.env ?? {}),
    };
    this.#child = spawn(
      this.#transport.command,
      [...(this.#transport.args ?? [])],
      {
        cwd: this.#transport.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#onStdout(chunk));
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.#child.once("error", (err) => this.#rejectAll(err));
    this.#child.once("close", (code, signal) => {
      if (this.#pending.size > 0) {
        this.#rejectAll(
          new Error(
            `MCP server exited before responding: code=${String(code)} signal=${String(signal)} stderr=${this.#stderr.trim()}`,
          ),
        );
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "reef", version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
  }

  async listTools(): Promise<readonly McpToolDefinition[]> {
    const result = asObject(await this.request("tools/list", {}));
    return normalizeTools(result?.tools);
  }

  async callTool(name: string, input: JsonValue): Promise<unknown> {
    const args =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? input
        : { value: input };
    return await this.request("tools/call", { name, arguments: args });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.#child === undefined) throw new Error("MCP server not started");
    const id = this.#nextId++;
    const message = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
    });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.#child === undefined) throw new Error("MCP server not started");
    this.#child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MCP client closed"));
    }
    this.#pending.clear();
    this.#child?.kill();
  }

  #onStdout(chunk: string): void {
    this.#stdout += chunk;
    for (;;) {
      const index = this.#stdout.indexOf("\n");
      if (index < 0) break;
      const line = this.#stdout.slice(0, index).trim();
      this.#stdout = this.#stdout.slice(index + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const obj = asObject(message);
      if (obj === undefined) continue;
      const id = typeof obj?.id === "number" ? obj.id : undefined;
      if (id === undefined) continue;
      const pending = this.#pending.get(id);
      if (pending === undefined) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      const error = asObject(obj.error);
      if (error !== undefined) {
        pending.reject(
          new Error(
            optionalString(error.message) ?? `MCP request ${id} failed`,
          ),
        );
      } else {
        pending.resolve(obj.result);
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function resultText(value: unknown): string {
  const obj = asObject(value);
  const content = obj?.content;
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const block = asObject(item);
        return block?.type === "text" && typeof block.text === "string"
          ? block.text
          : JSON.stringify(item);
      })
      .join("\n");
    if (text.trim() !== "") return text;
  }
  return JSON.stringify(value);
}

async function callMcpTool(
  power: InstalledPower,
  toolName: string,
  input: JsonValue,
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (power.transport.type !== "stdio") {
    return {
      ok: false,
      error:
        "HTTP MCP transports can be installed but are not used by the offline N5 verifier",
    };
  }
  const client = new StdioMcpClient(power.transport);
  try {
    client.start();
    await client.initialize();
    const result = await client.callTool(toolName, input);
    const obj = asObject(result);
    const isError = obj?.isError === true;
    const text = resultText(result);
    return isError ? { ok: false, error: text } : { ok: true, output: text };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.close();
  }
}

export class McpPowerRegistry {
  readonly #storePath: string | undefined;
  #installed: InstalledPower[] = [];

  constructor(persistDir?: string) {
    this.#storePath =
      persistDir === undefined ? undefined : join(persistDir, "powers.json");
    this.#installed = this.#load();
  }

  list(): PowerList {
    const installedIds = new Set(this.#installed.map((power) => power.id));
    return {
      installed: this.#installed.map(view),
      available: AVAILABLE_POWERS.filter(
        (power) => !installedIds.has(power.id),
      ),
      host: {
        mode: "reef-managed",
        reason:
          "Code-OSS MCP config exists, but the extension gateway/call API is proposed-gated; Reef calls MCP through its governed daemon.",
      },
    };
  }

  installAvailable(id: string): InstalledPower {
    const existing = this.get(id);
    if (existing !== undefined) return existing;
    const power = availableInstall(id);
    if (power === undefined) throw new Error(`unknown available power: ${id}`);
    this.#installed.push(power);
    this.#save();
    return power;
  }

  addCustom(input: AddCustomPowerRequest): InstalledPower {
    const name = optionalString(input.name) ?? "Custom Power";
    let id = slug(name);
    const ids = new Set(this.#installed.map((power) => power.id));
    if (ids.has(id)) {
      let i = 2;
      while (ids.has(`${id}-${i}`)) i++;
      id = `${id}-${i}`;
    }
    const transport = normalizeTransport(input);
    const description = optionalString(input.description);
    const tools = normalizeTools(input.tools);
    const allowedTools =
      stringArray(input.allowedTools) ?? tools.map((tool) => tool.name);
    const power: InstalledPower = {
      id,
      name,
      ...(description !== undefined ? { description } : {}),
      source: "custom",
      transport,
      tools,
      allowedTools,
    };
    this.#installed.push(power);
    this.#save();
    return power;
  }

  get(id: string): InstalledPower | undefined {
    return this.#installed.find((power) => power.id === id);
  }

  fullToolName(powerId: string, toolName: string): string {
    return mcpToolName(powerId, toolName);
  }

  allowedFullToolNames(power: InstalledPower): string[] {
    return power.allowedTools.map((tool) => mcpToolName(power.id, tool));
  }

  toolsFor(power: InstalledPower): Tool[] {
    return power.tools.map((tool) => ({
      name: mcpToolName(power.id, tool.name),
      description: `[${power.name}] ${tool.description ?? `MCP tool ${tool.name}`}`,
      inputSchema: { ...(tool.inputSchema ?? { type: "object" }) },
      run: (input) => callMcpTool(power, tool.name, input),
    }));
  }

  allTools(): Tool[] {
    return this.#installed.flatMap((power) => this.toolsFor(power));
  }

  allAllowedFullToolNames(): string[] {
    return this.#installed.flatMap((power) => this.allowedFullToolNames(power));
  }

  #load(): InstalledPower[] {
    if (this.#storePath === undefined) return [];
    try {
      const raw = JSON.parse(
        readFileSync(this.#storePath, "utf8"),
      ) as StoreFile;
      return Array.isArray(raw.installed) ? [...raw.installed] : [];
    } catch {
      return [];
    }
  }

  #save(): void {
    if (this.#storePath === undefined) return;
    mkdirSync(dirname(this.#storePath), { recursive: true });
    const body: StoreFile = { version: 1, installed: this.#installed };
    writeFileSync(
      this.#storePath,
      `${JSON.stringify(body, null, 2)}\n`,
      "utf8",
    );
  }
}
