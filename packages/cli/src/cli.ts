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
  UnsafeDemoDriver,
  loadSession,
  persistSession,
  type Driver,
  type ReefEvent,
} from "@octopus-reef/engine";
import { ClaudeDriver } from "@octopus-reef/driver-claude";
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
}

function parse(argv: readonly string[]): Flags {
  const positional: string[] = [];
  let out: string | undefined;
  let secret: string | undefined;
  let json = false;
  let demoDenial = false;
  let claude = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") out = argv[++i];
    else if (a === "--secret") secret = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--demo-denial") demoDenial = true;
    else if (a === "--claude") claude = true;
    else positional.push(a);
  }
  return { _: positional, out, secret, json, demoDenial, claude };
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
      ``,
      `${c.bold("COMMANDS")}`,
      `  ${c.signal("run")}     Run a governed agentic session. Every step becomes a`,
      `          tamper-evident evidence link over a governed work spine.`,
      `  ${c.signal("verify")}  Load a persisted session and re-verify it store-untrusting.`,
      ``,
      `${c.bold("FLAGS")}`,
      `  --out <dir>     Persist the session (workstate.jsonl + session.log.jsonl).`,
      `  --secret <key>  Keyed mode: bind every link with an HMAC.`,
      `  --claude        Use the real Claude agent driver (needs ANTHROPIC_API_KEY; plans under governance, does not execute yet).`,
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
  const driver: Driver = flags.claude
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

  const session = new GovernedSession({
    id,
    task,
    driver,
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

async function main(): Promise<number> {
  const flags = parse(process.argv.slice(2));
  const command = flags._[0];
  switch (command) {
    case "run":
      return runCommand(flags);
    case "verify":
      return verifyCommand(flags);
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
