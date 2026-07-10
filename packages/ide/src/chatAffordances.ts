import type {
  ChatCommandId,
  ChatCommandResolution,
  ChatRouteResolution,
  ChatTaskReference,
  SpecTaskView,
} from "@octopus-reef/protocol";

export interface ChatCommandItem extends ChatCommandResolution {
  readonly description: string;
}

export interface ChatRouteItem extends ChatRouteResolution {
  readonly description: string;
}

export interface ChatTaskCandidate extends ChatTaskReference {
  readonly specTitle?: string;
}

export interface ResolvedChatAffordances {
  readonly command?: ChatCommandResolution;
  readonly taskRef?: ChatTaskReference;
  readonly route: ChatRouteResolution;
}

export type ChatAffordanceResolution =
  | { readonly ok: true; readonly affordances: ResolvedChatAffordances }
  | {
      readonly ok: false;
      readonly token: string;
      readonly message: string;
    };

export const CHAT_COMMANDS: readonly ChatCommandItem[] = [
  {
    id: "spec",
    token: "/spec",
    label: "Spec",
    description: "Shape a governed workstate spec before the run.",
  },
  {
    id: "plan",
    token: "/plan",
    label: "Plan",
    description: "Ask Reef to plan before edits begin.",
  },
  {
    id: "bug-fix",
    token: "/bug-fix",
    label: "Bug Fix",
    description: "Trace, patch, and verify a failure.",
  },
  {
    id: "replay",
    token: "/replay",
    label: "Replay",
    description: "Re-check evidence and explain what changed.",
  },
  {
    id: "verify",
    token: "/verify",
    label: "Verify",
    description: "Verify the latest governed turn.",
  },
  {
    id: "new-session",
    token: "/new-session",
    label: "New Session",
    description: "Start a new governed chat thread.",
  },
];

export const CHAT_ROUTES: readonly ChatRouteItem[] = [
  {
    token: "@code",
    worker: "codeWorker",
    label: "Code Worker",
    description: "Route the turn to the code worker.",
  },
  {
    token: "@tool",
    worker: "toolWorker",
    label: "Tool Worker",
    description: "Route the turn to the tool worker.",
  },
  {
    token: "@cli:claude",
    worker: "cliWorker",
    cli: "claude",
    label: "Claude CLI Worker",
    description: "Route through the Claude CLI worker.",
  },
  {
    token: "@cli:codex",
    worker: "cliWorker",
    cli: "codex",
    label: "Codex CLI Worker",
    description: "Route through the Codex CLI worker.",
  },
  {
    token: "@cli:gemini",
    worker: "cliWorker",
    cli: "gemini",
    label: "Gemini CLI Worker",
    description: "Route through the Gemini CLI worker.",
  },
];

export const CHAT_AUTO_ROUTE: ChatRouteResolution = {
  token: "auto",
  worker: "auto",
  label: "Auto Router",
};

const COMMAND_BY_TOKEN = new Map(
  CHAT_COMMANDS.map((command) => [command.token, command]),
);
const ROUTE_BY_TOKEN = new Map(
  CHAT_ROUTES.map((route) => [route.token, route]),
);

export function openTaskCandidates(
  specs: readonly {
    readonly id: string;
    readonly title: string;
    readonly tasks: readonly SpecTaskView[];
  }[],
): ChatTaskCandidate[] {
  return specs.flatMap((spec) =>
    spec.tasks
      .filter((task) => task.state !== "done")
      .map((task) => ({
        specId: spec.id,
        specTitle: spec.title,
        itemId: task.id,
        title: task.title,
        state: task.state,
        ...(task.history.at(-1)?.evidenceId !== undefined
          ? { evidenceId: task.history.at(-1)!.evidenceId }
          : {}),
      })),
  );
}

export function resolveChatAffordances(
  text: string,
  tasks: readonly ChatTaskCandidate[],
): ChatAffordanceResolution {
  const commandTokens = tokens(text, "/");
  const taskTokens = tokens(text, "#");
  const routeTokens = tokens(text, "@");

  if (commandTokens.length > 1) {
    return reject(commandTokens[1]!, "Use only one / command per turn.");
  }
  if (taskTokens.length > 1) {
    return reject(taskTokens[1]!, "Use only one # task reference per turn.");
  }
  if (routeTokens.length > 1) {
    return reject(routeTokens[1]!, "Use only one @ role-agent route per turn.");
  }

  const command =
    commandTokens.length === 0
      ? undefined
      : COMMAND_BY_TOKEN.get(commandTokens[0]!.toLowerCase());
  if (commandTokens.length > 0 && command === undefined) {
    return reject(
      commandTokens[0]!,
      `Unknown Reef command "${commandTokens[0]}".`,
    );
  }

  const taskRef =
    taskTokens.length === 0
      ? undefined
      : tasks.find((task) => `#${task.itemId}` === taskTokens[0]);
  if (taskTokens.length > 0 && taskRef === undefined) {
    return reject(
      taskTokens[0]!,
      `Unknown or closed Reef task "${taskTokens[0]}".`,
    );
  }

  const route =
    routeTokens.length === 0
      ? CHAT_AUTO_ROUTE
      : ROUTE_BY_TOKEN.get(routeTokens[0]!.toLowerCase());
  if (routeTokens.length > 0 && route === undefined) {
    return reject(
      routeTokens[0]!,
      `Unknown Reef role-agent route "${routeTokens[0]}".`,
    );
  }
  const routeForEvidence = route ?? CHAT_AUTO_ROUTE;

  return {
    ok: true,
    affordances: {
      ...(command !== undefined ? { command: publicCommand(command) } : {}),
      ...(taskRef !== undefined ? { taskRef: publicTask(taskRef) } : {}),
      route: publicRoute(routeForEvidence),
    },
  };
}

export function pickerItems(
  trigger: "/" | "#" | "@",
  query: string,
  tasks: readonly ChatTaskCandidate[],
): readonly (ChatCommandItem | ChatRouteItem | ChatTaskCandidate)[] {
  const q = query.toLowerCase();
  if (trigger === "/") {
    return CHAT_COMMANDS.filter(
      (item) =>
        item.token.slice(1).includes(q) || item.label.toLowerCase().includes(q),
    );
  }
  if (trigger === "@") {
    return CHAT_ROUTES.filter(
      (item) =>
        item.token.slice(1).includes(q) || item.label.toLowerCase().includes(q),
    );
  }
  return tasks.filter(
    (task) =>
      task.itemId.toLowerCase().includes(q) ||
      task.title.toLowerCase().includes(q) ||
      (task.specTitle ?? "").toLowerCase().includes(q),
  );
}

function tokens(text: string, prefix: "/" | "#" | "@"): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.startsWith(prefix) && token.length > 1);
}

function reject(
  token: string,
  message: string,
): Extract<ChatAffordanceResolution, { ok: false }> {
  return { ok: false, token, message };
}

function publicCommand(command: ChatCommandItem): ChatCommandResolution {
  return {
    id: command.id as ChatCommandId,
    token: command.token,
    label: command.label,
  };
}

function publicTask(task: ChatTaskCandidate): ChatTaskReference {
  return {
    specId: task.specId,
    itemId: task.itemId,
    title: task.title,
    state: task.state,
    ...(task.evidenceId !== undefined ? { evidenceId: task.evidenceId } : {}),
  };
}

function publicRoute(route: ChatRouteResolution): ChatRouteResolution {
  return {
    token: route.token,
    worker: route.worker,
    label: route.label,
    ...(route.cli !== undefined ? { cli: route.cli } : {}),
  };
}
