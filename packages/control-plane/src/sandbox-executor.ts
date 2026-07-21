import { posix } from "node:path";
import type {
  ActionExecutor,
  ActionRequest,
  ExecOutcome,
} from "@octopus-reef/engine";
import type { SandboxExecutionResult, SandboxHandle } from "./types.js";

const MAX_READ_BYTES = 4_000;

/** Executes the existing AgentWorker actions inside the provisioned sandbox. */
export class SandboxActionExecutor implements ActionExecutor {
  readonly name = "control-plane-sandbox";

  constructor(private readonly sandbox: SandboxHandle) {}

  async execute(action: ActionRequest): Promise<ExecOutcome> {
    try {
      switch (action.type) {
        case "read":
          return outcome(
            await this.sandbox.execute({
              argv: [
                "node",
                "-e",
                "const fs=require('node:fs');const b=fs.readFileSync(process.argv[1]);process.stdout.write(b.subarray(0,4000))",
                confinedPath(action.target),
              ],
            }),
          );
        case "edit": {
          const content = action.payload?.["content"];
          if (typeof content !== "string") {
            return { ok: false, error: "edit requires payload.content" };
          }
          return outcome(
            await this.sandbox.execute({
              argv: [
                "node",
                "-e",
                "const fs=require('node:fs'),p=require('node:path');const f=process.argv[1];fs.mkdirSync(p.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(process.argv[2],'base64'));process.stdout.write('wrote '+fs.statSync(f).size+' bytes')",
                confinedPath(action.target),
                Buffer.from(content, "utf8").toString("base64"),
              ],
            }),
          );
        }
        case "command": {
          const command = action.payload?.["command"];
          if (typeof command !== "string" || command === "") {
            return { ok: false, error: "command requires payload.command" };
          }
          return outcome(
            await this.sandbox.execute({
              argv: ["/bin/sh", "-lc", command],
            }),
          );
        }
        default:
          return {
            ok: false,
            error: `'${action.type}' requires an explicitly registered tool executor`,
          };
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function confinedPath(target: string | undefined): string {
  if (target === undefined || target === "") {
    throw new Error("workspace path is required");
  }
  const normalized = posix.normalize(target.replaceAll("\\", "/"));
  if (
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`path escapes the workspace: ${target}`);
  }
  return normalized;
}

function outcome(result: SandboxExecutionResult): ExecOutcome {
  return result.exitCode === 0
    ? {
        ok: true,
        output: result.stdout.slice(0, MAX_READ_BYTES),
        exitCode: result.exitCode,
      }
    : {
        ok: false,
        error: result.stderr.slice(0, MAX_READ_BYTES),
        exitCode: result.exitCode,
      };
}
