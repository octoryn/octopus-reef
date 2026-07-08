#!/usr/bin/env node
/**
 * reef — the Reef terminal surface.
 *
 *   reef run "<task>"   run a governed session (offline mock driver)
 *   reef verify <dir>   independently re-verify a persisted session
 *
 * The CLI is thin: all governance lives in @octopus-reef/engine. This surface
 * runs fully offline and keyless — the mock driver exercises the entire
 * governed substrate without an API key, so the Docker demo works out of the box.
 */
import {
  GovernedSession,
  MockDriver,
  SandboxExecutor,
  UnsafeDemoDriver,
  WorkspaceExecutor,
  loadSession,
  persistSession,
  reefAllowlist,
  replaySession,
  type ActionExecutor,
  type Driver,
  type ReefEvent,
} from "@octopus-reef/engine";
import { ClaudeDriver } from "@octopus-reef/driver-claude";
import { AgentWorker, BedrockProvider } from "@octopus-reef/agent";
import { ReefServer } from "@octopus-reef/server";
import { inspect, shouldFail } from "octopus-inspect";
import {
  banner,
  c,
  outcomeLabel,
  renderEvent,
  rule,
  verdictLine,
} from "./render.js";

interface Flags {
  readonly _: string[];
  readonly out: string | undefined;
  readonly secret: string | undefined;
  readonly json: boolean;
  readonly demoDenial: boolean;
  readonly claude: boolean;
  readonly agent: boolean;
  readonly workspace: string | undefined;
  readonly sandbox: boolean;
}

/**
 * The build/test allowlist the agent worker runs under (with --workspace
 * --sandbox): common test runners, contained by the OS sandbox (no network,
 * writes confined, throwaway HOME). Wider than the default read-only allowlist
 * because an agent must actually run the tests it is judged on.
 */
const AGENT_COMMANDS = {
  node: "*",
  npm: ["test", "run", "ci", "install", "exec"],
  npx: "*",
  pnpm: ["test", "run", "install"],
  yarn: ["test", "run", "install"],
  python3: "*",
  pytest: "*",
  go: ["test", "build", "vet"],
  cargo: ["test", "build"],
} as const;

function parse(argv: readonly string[]): Flags {
  const positional: string[] = [];
  let out: string | undefined;
  let secret: string | undefined;
  let json = false;
  let demoDenial = false;
  let claude = false;
  let agent = false;
  let workspace: string | undefined;
  let sandbox = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") out = argv[++i];
    else if (a === "--secret") secret = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--demo-denial") demoDenial = true;
    else if (a === "--claude") claude = true;
    else if (a === "--agent") agent = true;
    else if (a === "--workspace") workspace = argv[++i];
    else if (a === "--sandbox") sandbox = true;
    else positional.push(a);
  }
  return {
    _: positional,
    out,
    secret,
    json,
    demoDenial,
    claude,
    agent,
    workspace,
    sandbox,
  };
}

function sessionId(): string {
  return `sess-${Date.now().toString(36)}`;
}

function help(): void {
  process.stdout.write(banner());
  process.stdout.write(
    [
      `${c.bold("USAGE")}`,
      `  reef run "<task>" [--out <dir>] [--secret <key>] [--demo-denial] [--json]`,
      `  reef verify <dir> [--secret <key>] [--json]`,
      `  reef replay <dir> [--secret <key>] [--json]`,
      `  reef inspect [<dir>] [--json]`,
      `  reef serve [<port>] [--out <dir>]`,
      ``,
      `${c.bold("COMMANDS")}`,
      `  ${c.signal("run")}     Run a governed agentic session. Every step becomes a`,
      `          tamper-evident evidence link over a governed work spine.`,
      `  ${c.signal("verify")}  Load a persisted session and re-verify it store-untrusting.`,
      `  ${c.signal("replay")}  Re-verify AND reconstruct a session's full timeline from the log.`,
      `  ${c.signal("inspect")} Static governance lint over a workspace (secrets, agentic-OWASP).`,
      `  ${c.signal("serve")}   Start the daemon (HTTP + SSE) that every surface shares.`,
      ``,
      `${c.bold("FLAGS")}`,
      `  --out <dir>     Persist the session (workstate.jsonl + session.log.jsonl).`,
      `  --secret <key>  Keyed mode: bind every link with an HMAC.`,
      `  --claude        Use the real Claude planning driver (needs ANTHROPIC_API_KEY; plans under governance, does not execute).`,
      `  --agent         Use Reef's OWN agentic worker (reads, edits, runs tests, iterates). With --workspace --sandbox it does`,
      `                  real, confined work; the model is rented via a provider (Bedrock: needs AWS_BEARER_TOKEN_BEDROCK).`,
      `  --workspace <dir>  Enable real execution under the allowlist: confined file read/edit in <dir>.`,
      `  --sandbox       With --workspace, also run allowlisted read-only commands in an OS sandbox`,
      `                  (macOS sandbox-exec: no network, writes confined to <dir>, timeout, scrubbed env).`,
      `  --demo-denial   Use a driver that proposes a dangerous command, to show the gate.`,
      `  --json          Machine-readable output.`,
      ``,
    ].join("\n") + "\n",
  );
}

async function runCommand(flags: Flags): Promise<number> {
  const task = flags._[1];
  if (task === undefined || task.length === 0) {
    process.stderr.write(
      c.danger(
        'error: reef run needs a task, e.g. reef run "add rate limiting"\n',
      ),
    );
    return 2;
  }
  const driver: Driver = flags.agent
    ? new AgentWorker({ provider: new BedrockProvider() })
    : flags.claude
      ? new ClaudeDriver()
      : flags.demoDenial
        ? new UnsafeDemoDriver()
        : new MockDriver();
  const id = sessionId();
  const events: ReefEvent[] = [];

  if (!flags.json) {
    process.stdout.write(banner());
    process.stdout.write(
      `${c.muted("session")} ${c.ink(id)}  ${c.muted("·")}  ${c.ink(task)}\n`,
    );
    process.stdout.write(
      `${c.muted("driver")}  ${c.ink(driver.name)}${flags.secret ? c.muted("  · keyed") : ""}\n\n`,
    );
  }

  const workspaceWiring =
    flags.workspace !== undefined
      ? {
          // The agent needs to run the tests it is judged on, so it gets the
          // wider build/test allowlist — still contained by the OS sandbox.
          authorizer: flags.agent
            ? reefAllowlist({ commands: AGENT_COMMANDS })
            : reefAllowlist(),
          executor: (flags.sandbox
            ? new SandboxExecutor(flags.workspace)
            : new WorkspaceExecutor(flags.workspace)) as ActionExecutor,
        }
      : {};

  const session = new GovernedSession({
    id,
    task,
    driver,
    ...workspaceWiring,
    ...(flags.secret !== undefined ? { integritySecret: flags.secret } : {}),
    onEvent: (e) => {
      events.push(e);
      if (!flags.json) process.stdout.write(renderEvent(e) + "\n");
    },
  });

  const { snapshot } = await session.run();
  const verdict = session.verify();

  if (flags.out !== undefined) persistSession(session, flags.out);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          snapshot,
          verify: verdict,
          out: flags.out ?? null,
          events: events.length,
        },
        null,
        2,
      ) + "\n",
    );
    return verdict.ok ? 0 : 1;
  }

  process.stdout.write(`\n${rule("proof")}\n`);
  process.stdout.write(
    `  ${c.muted("outcome")} ${outcomeLabel(snapshot.outcome)}   ` +
      `${c.muted("state")} ${c.signal(snapshot.workState)}   ` +
      `${c.muted("work links")} ${c.ink(String(snapshot.workChainLength))}   ` +
      `${c.muted("evidence links")} ${c.ink(String(snapshot.logChainLength))}\n`,
  );
  process.stdout.write(
    `  ${verdictLine(verdict.ok, verdict.work, verdict.log, verdict.binding)}\n`,
  );
  if (flags.out !== undefined) {
    process.stdout.write(
      `  ${c.muted("persisted →")} ${c.ink(flags.out)}   ${c.dim(`reef verify ${flags.out}`)}\n`,
    );
  }
  process.stdout.write("\n");
  return verdict.ok ? 0 : 1;
}

function verifyCommand(flags: Flags): number {
  const dir = flags._[1];
  if (dir === undefined) {
    process.stderr.write(
      c.danger("error: reef verify needs a session directory\n"),
    );
    return 2;
  }
  try {
    const loaded = loadSession(
      dir,
      flags.secret !== undefined ? { integritySecret: flags.secret } : {},
    );
    if (flags.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            workState: loaded.workState,
            workChainLength: loaded.workChainLength,
            logChainLength: loaded.logChainLength,
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(banner());
      process.stdout.write(
        `  ${verdictLine(true, "intact", "intact", "bound")}\n`,
      );
      process.stdout.write(
        `  ${c.muted("work state")} ${c.signal(String(loaded.workState))}   ` +
          `${c.muted("work links")} ${c.ink(String(loaded.workChainLength))}   ` +
          `${c.muted("evidence links")} ${c.ink(String(loaded.logChainLength))}\n\n`,
      );
    }
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (flags.json)
      process.stdout.write(
        JSON.stringify({ ok: false, reason }, null, 2) + "\n",
      );
    else {
      process.stdout.write(banner());
      process.stdout.write(
        `  ${c.danger("⨯ VERIFICATION FAILED")}  ${c.muted(reason)}\n\n`,
      );
    }
    return 1;
  }
}

async function serveCommand(flags: Flags): Promise<number> {
  const portArg = flags._[1];
  const port = portArg !== undefined ? Number(portArg) : 4300;
  if (Number.isNaN(port)) {
    process.stderr.write(c.danger(`error: invalid port: ${portArg}\n`));
    return 2;
  }
  const server = new ReefServer(
    flags.out !== undefined ? { persistDir: flags.out } : {},
  );
  const bound = await server.listen(port);
  process.stdout.write(banner());
  process.stdout.write(
    `  ${c.muted("serving")} ${c.ink(`http://127.0.0.1:${bound}`)}   ${c.dim("(Ctrl-C to stop)")}\n` +
      `  ${c.muted("POST")} ${c.ink("/sessions")}   ${c.muted("GET")} ${c.ink("/sessions/:id/events")}   ${c.muted("GET")} ${c.ink("/sessions/:id/verify")}\n\n`,
  );
  return new Promise<number>((resolve) => {
    const stop = (): void => {
      void server.close().then(() => resolve(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

function replayCommand(flags: Flags): number {
  const dir = flags._[1];
  if (dir === undefined) {
    process.stderr.write(
      c.danger("error: reef replay needs a session directory\n"),
    );
    return 2;
  }
  try {
    const replayed = replaySession(
      dir,
      flags.secret !== undefined ? { integritySecret: flags.secret } : {},
    );
    if (flags.json) {
      process.stdout.write(JSON.stringify(replayed, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(banner());
    process.stdout.write(
      `  ${verdictLine(true, "intact", "intact", "bound")}   ${c.muted("replayed")} ${c.ink(String(replayed.events.length))} ${c.muted("events")}\n\n`,
    );
    for (const e of replayed.events) {
      process.stdout.write(renderEvent(e) + "\n");
    }
    process.stdout.write("\n");
    return 0;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (flags.json)
      process.stdout.write(
        JSON.stringify({ ok: false, reason }, null, 2) + "\n",
      );
    else {
      process.stdout.write(banner());
      process.stdout.write(
        `  ${c.danger("⨯ REPLAY FAILED")}  ${c.muted(reason)}\n\n`,
      );
    }
    return 1;
  }
}

async function inspectCommand(flags: Flags): Promise<number> {
  const dir = flags._[1] ?? ".";
  let report: Awaited<ReturnType<typeof inspect>>;
  try {
    report = await inspect(dir);
  } catch (err) {
    process.stderr.write(
      c.danger(`error: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    return 2;
  }
  const failed = shouldFail(report);
  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return failed ? 1 : 0;
  }

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of report.findings) counts[f.severity]++;
  const sevTag = (s: "error" | "warning" | "info"): string =>
    s === "error"
      ? c.danger("error  ")
      : s === "warning"
        ? c.amber("warning")
        : c.muted("info   ");

  process.stdout.write(banner());
  process.stdout.write(`${rule("governance inspect")}\n`);
  process.stdout.write(
    `  ${c.muted("workspace")} ${c.ink(report.root)}   ` +
      `${c.muted("files")} ${c.ink(String(report.fileCount))}   ` +
      `${c.muted("rules")} ${c.ink(String(report.ruleCount))}\n\n`,
  );
  if (report.findings.length === 0) {
    process.stdout.write(`  ${c.signal("✓ no governance holes found")}\n\n`);
    return 0;
  }
  for (const f of report.findings) {
    const loc = c.muted(`${f.file}${f.line !== undefined ? `:${f.line}` : ""}`);
    process.stdout.write(
      `  ${sevTag(f.severity)}  ${c.ink(f.ruleId)}  ${f.message}  ${loc}\n`,
    );
  }
  const tally = [
    counts.error > 0 ? c.danger(`${counts.error} error`) : "",
    counts.warning > 0 ? c.amber(`${counts.warning} warning`) : "",
    counts.info > 0 ? c.muted(`${counts.info} info`) : "",
  ].filter((s) => s.length > 0);
  process.stdout.write(`\n  ${tally.join("   ")}\n\n`);
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const flags = parse(process.argv.slice(2));
  const command = flags._[0];
  switch (command) {
    case "run":
      return runCommand(flags);
    case "serve":
      return serveCommand(flags);
    case "verify":
      return verifyCommand(flags);
    case "replay":
      return replayCommand(flags);
    case "inspect":
      return inspectCommand(flags);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      return 0;
    default:
      process.stderr.write(c.danger(`unknown command: ${command}\n`));
      help();
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
