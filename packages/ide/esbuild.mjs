// Bundle the extension host into a single CJS file (VS Code loads CJS). `vscode`
// is provided by the runtime, so it's external; the protocol import is type-only
// and erases, so nothing else needs resolving.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const edition =
  process.env.REEF_EDITION === "commercial" ? "commercial" : "community";
const commercialEntry = fileURLToPath(
  new URL("./src/commercial/edition-commercial.ts", import.meta.url),
);

const editionAlias = {
  name: "reef-edition-alias",
  setup(bundle) {
    bundle.onResolve({ filter: /^\.\/commercial\/edition\.js$/ }, (args) => {
      if (edition !== "commercial") return undefined;
      if (!args.importer.endsWith("/src/extension.ts")) return undefined;
      return { path: commercialEntry };
    });
  },
};

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  define: {
    "process.env.REEF_EDITION": JSON.stringify(edition),
  },
  plugins: [editionAlias],
  sourcemap: true,
  logLevel: "info",
});
