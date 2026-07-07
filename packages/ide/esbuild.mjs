// Bundle the extension host into a single CJS file (VS Code loads CJS). `vscode`
// is provided by the runtime, so it's external; the protocol import is type-only
// and erases, so nothing else needs resolving.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});
