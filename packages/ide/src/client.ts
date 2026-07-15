/**
 * The Reef daemon client used by the VS Code extension host. Node has global
 * `fetch` but no `EventSource`, so we read the SSE stream off the fetch body
 * ourselves. The frame parsing is a pure function so it's testable without a
 * network or a browser.
 */
import type {
  AdvanceSpecRequest,
  AdvanceSpecResponse,
  AccountLoginRequest,
  AccountPlanResponse,
  CreateSpecRequest,
  CreateSpecResponse,
  CreateSessionResponse,
  EditionResponse,
  ServerEvent,
  SpecListResponse,
  SpecView,
  SpecVerifyResult,
  AddCustomSteeringRequest,
  ChatCommandResolution,
  ChatRouteResolution,
  ChatTaskReference,
  CreateHookRequest,
  CreateManagerFleetRequest,
  CreateManagerFleetResponse,
  FireHookRequest,
  FireHookResponse,
  HookDefinitionView,
  HookListResponse,
  ManagerFleetVerifyResponse,
  ManagerFleetView,
  SetSteeringActiveRequest,
  SteeringItemView,
  SteeringListResponse,
  UsageSummaryResponse,
} from "@octopus-reef/protocol";

export type { ServerEvent };

/**
 * Pull complete `data: …\n\n` SSE frames out of an accumulating buffer, invoking
 * `onFrame` for each parsed {@link ServerEvent}, and return the unconsumed tail.
 */
export function drainSSE(
  buffer: string,
  onFrame: (event: ServerEvent) => void,
): string {
  let rest = buffer;
  for (;;) {
    const brk = rest.indexOf("\n\n");
    if (brk < 0) break;
    const chunk = rest.slice(0, brk);
    rest = rest.slice(brk + 2);
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (line === undefined) continue;
    try {
      const obj: unknown = JSON.parse(line.slice(6));
      if (
        typeof obj === "object" &&
        obj !== null &&
        "type" in obj &&
        (obj.type === "hello" || obj.type === "event" || obj.type === "sealed")
      ) {
        onFrame(obj as ServerEvent);
      }
    } catch {
      /* ignore a malformed frame */
    }
  }
  return rest;
}

export interface CreateSessionOptions {
  readonly secret?: string;
  readonly persist?: boolean;
  readonly workspaceRoot?: string;
  readonly model?: {
    readonly provider?: string;
    readonly apiKey?: string;
    readonly name?: string;
    readonly licenseToken?: string;
    readonly gatewayUrl?: string;
    readonly priorityTier?: "standard" | "priority";
  };
  readonly mcp?: {
    readonly serverId?: string;
    readonly tool?: string;
    readonly input?: unknown;
    readonly expectDenied?: boolean;
  };
  readonly browser?: {
    readonly url?: string;
    readonly tool?: string;
    readonly selector?: string;
    readonly expectDenied?: boolean;
    readonly annotation?: {
      readonly url?: string;
      readonly note?: string;
      readonly bbox?: {
        readonly x?: number;
        readonly y?: number;
        readonly width?: number;
        readonly height?: number;
        readonly viewportWidth?: number;
        readonly viewportHeight?: number;
      };
    };
  };
  readonly spec?: {
    readonly specId?: string;
    readonly itemId?: string;
    readonly to?: import("@octopus-reef/protocol").WorkState;
    readonly reason?: string;
  };
  readonly steering?: {
    readonly ids?: readonly string[];
  };
  readonly conversation?: {
    readonly id?: string;
    readonly turn?: number;
    readonly parentSessionId?: string;
    readonly autopilot?: boolean;
    readonly approvalMode?: "auto" | "ask";
    readonly command?: ChatCommandResolution;
    readonly taskRef?: ChatTaskReference;
    readonly route?: ChatRouteResolution;
  };
  readonly account?: {
    readonly provider?: string;
    readonly model?: string;
    readonly source?: string;
    readonly gatewayUrl?: string;
    readonly ssoUrl?: string;
  };
}

/** Start a governed session on the daemon; resolves with its id. */
export async function createSession(
  baseUrl: string,
  task: string,
  options: CreateSessionOptions = {},
): Promise<string> {
  const res = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task,
      ...(options.secret ? { secret: options.secret } : {}),
      ...(options.persist ? { persist: true } : {}),
      ...(options.workspaceRoot
        ? { workspaceRoot: options.workspaceRoot }
        : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.mcp !== undefined ? { mcp: options.mcp } : {}),
      ...(options.browser !== undefined ? { browser: options.browser } : {}),
      ...(options.spec !== undefined ? { spec: options.spec } : {}),
      ...(options.steering !== undefined ? { steering: options.steering } : {}),
      ...(options.conversation !== undefined
        ? { conversation: options.conversation }
        : {}),
      ...(options.account !== undefined ? { account: options.account } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`daemon returned ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as CreateSessionResponse;
  return body.id;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

export interface InstalledPower {
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

export interface AvailablePower {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly transport: "stdio" | "http";
  readonly tools: readonly McpToolDefinition[];
  readonly allowedTools: readonly string[];
}

export interface PowersList {
  readonly installed: readonly InstalledPower[];
  readonly available: readonly AvailablePower[];
  readonly host: {
    readonly mode: "reef-managed";
    readonly reason: string;
  };
}

async function jsonRequest<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      /* keep status text */
    }
    throw new Error(`daemon returned ${detail}`);
  }
  return (await res.json()) as T;
}

export async function listPowers(baseUrl: string): Promise<PowersList> {
  return await jsonRequest<PowersList>(`${baseUrl}/powers`);
}

export async function getEdition(baseUrl: string): Promise<EditionResponse> {
  return await jsonRequest<EditionResponse>(`${baseUrl}/edition`);
}

export async function installPower(
  baseUrl: string,
  id: string,
): Promise<InstalledPower> {
  const body = await jsonRequest<{ installed: InstalledPower }>(
    `${baseUrl}/powers/install`,
    {
      method: "POST",
      body: JSON.stringify({ id }),
    },
  );
  return body.installed;
}

export async function addCustomPower(
  baseUrl: string,
  input: Record<string, unknown>,
): Promise<InstalledPower> {
  const body = await jsonRequest<{ installed: InstalledPower }>(
    `${baseUrl}/powers/custom`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.installed;
}

export async function listSpecs(baseUrl: string): Promise<SpecListResponse> {
  return await jsonRequest<SpecListResponse>(`${baseUrl}/specs`);
}

export async function createSpec(
  baseUrl: string,
  input: CreateSpecRequest,
): Promise<SpecView> {
  const body = await jsonRequest<CreateSpecResponse>(`${baseUrl}/specs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.spec;
}

export async function getSpec(baseUrl: string, id: string): Promise<SpecView> {
  return await jsonRequest<SpecView>(
    `${baseUrl}/specs/${encodeURIComponent(id)}`,
  );
}

export async function advanceSpec(
  baseUrl: string,
  id: string,
  input: AdvanceSpecRequest,
): Promise<AdvanceSpecResponse> {
  return await jsonRequest<AdvanceSpecResponse>(
    `${baseUrl}/specs/${encodeURIComponent(id)}/advance`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function verifySpec(
  baseUrl: string,
  id: string,
): Promise<SpecVerifyResult> {
  return await jsonRequest<SpecVerifyResult>(
    `${baseUrl}/specs/${encodeURIComponent(id)}/verify`,
  );
}

export async function getUsage(baseUrl: string): Promise<UsageSummaryResponse> {
  return await jsonRequest<UsageSummaryResponse>(`${baseUrl}/usage`);
}

export interface AccountQuery {
  readonly provider?: string;
  readonly model?: string;
  readonly source?: string;
  readonly gatewayUrl?: string;
  readonly ssoUrl?: string;
  readonly priorityTier?: "standard" | "priority";
}

function accountUrl(
  baseUrl: string,
  path = "/account",
  query: AccountQuery = {},
): string {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string" && value.trim() !== "") {
      url.searchParams.set(key, value.trim());
    }
  }
  return url.toString();
}

export async function getAccount(
  baseUrl: string,
  query: AccountQuery = {},
): Promise<AccountPlanResponse> {
  return await jsonRequest<AccountPlanResponse>(
    accountUrl(baseUrl, "/account", query),
  );
}

export async function loginAccount(
  baseUrl: string,
  query: AccountQuery = {},
  input: AccountLoginRequest = {},
): Promise<AccountPlanResponse> {
  return await jsonRequest<AccountPlanResponse>(
    accountUrl(baseUrl, "/account/login", query),
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function logoutAccount(
  baseUrl: string,
  query: AccountQuery = {},
): Promise<AccountPlanResponse> {
  return await jsonRequest<AccountPlanResponse>(
    accountUrl(baseUrl, "/account/logout", query),
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function listSteering(
  baseUrl: string,
): Promise<SteeringListResponse> {
  return await jsonRequest<SteeringListResponse>(`${baseUrl}/steering`);
}

export async function setActiveSteering(
  baseUrl: string,
  input: SetSteeringActiveRequest,
): Promise<SteeringListResponse> {
  return await jsonRequest<SteeringListResponse>(`${baseUrl}/steering/active`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function addCustomSteering(
  baseUrl: string,
  input: AddCustomSteeringRequest,
): Promise<SteeringItemView> {
  const body = await jsonRequest<{ steering: SteeringItemView }>(
    `${baseUrl}/steering/custom`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.steering;
}

export async function listHooks(baseUrl: string): Promise<HookListResponse> {
  return await jsonRequest<HookListResponse>(`${baseUrl}/hooks`);
}

export async function createHook(
  baseUrl: string,
  input: CreateHookRequest,
): Promise<HookDefinitionView> {
  const body = await jsonRequest<{ hook: HookDefinitionView }>(
    `${baseUrl}/hooks`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.hook;
}

export async function fireHook(
  baseUrl: string,
  id: string,
  input: FireHookRequest = {},
): Promise<FireHookResponse> {
  return await jsonRequest<FireHookResponse>(
    `${baseUrl}/hooks/${encodeURIComponent(id)}/fire`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function createManagerFleet(
  baseUrl: string,
  input: CreateManagerFleetRequest,
): Promise<ManagerFleetView> {
  const body = await jsonRequest<CreateManagerFleetResponse>(
    `${baseUrl}/manager/fleets`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return body.fleet;
}

export async function getManagerFleet(
  baseUrl: string,
  id: string,
): Promise<ManagerFleetView> {
  return await jsonRequest<ManagerFleetView>(
    `${baseUrl}/manager/fleets/${encodeURIComponent(id)}`,
  );
}

export async function verifyManagerFleet(
  baseUrl: string,
  id: string,
): Promise<ManagerFleetVerifyResponse> {
  return await jsonRequest<ManagerFleetVerifyResponse>(
    `${baseUrl}/manager/fleets/${encodeURIComponent(id)}/verify`,
  );
}

/** Re-verify a sealed session through the daemon. */
export async function verifySession(
  baseUrl: string,
  id: string,
): Promise<import("@octopus-reef/protocol").VerifyResult> {
  const res = await fetch(`${baseUrl}/sessions/${id}/verify`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`daemon returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as import("@octopus-reef/protocol").VerifyResult;
}

/** A single SSE frame (or the pending tail) must fit in this much memory. */
const MAX_BUFFER = 1_000_000;
/** Abort the stream if no bytes arrive for this long (a hung daemon). */
const IDLE_MS = 120_000;

async function readWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("event stream idle timeout")),
      ms,
    );
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Stream a session's evidence to `onEvent` until it seals (or `signal` aborts).
 * Reads the SSE body off `fetch` — no EventSource needed in the extension host.
 * Bounded: a delimiter-less flood can't grow memory without limit, and a hung
 * daemon trips the idle timeout instead of blocking forever.
 */
export async function streamEvents(
  baseUrl: string,
  id: string,
  onEvent: (event: ServerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${baseUrl}/sessions/${id}/events`, {
    headers: { accept: "text/event-stream" },
    ...(signal !== undefined ? { signal } : {}),
  });
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await readWithTimeout(reader, IDLE_MS);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = drainSSE(buffer, onEvent);
      if (buffer.length > MAX_BUFFER) {
        throw new Error("event stream exceeded the frame size limit");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
