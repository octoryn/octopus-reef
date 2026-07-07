import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The web app (JSX/DOM) and the VS Code extension (vscode/DOM globals) have
  // their own `tsc -p` typechecks and bundlers; they aren't in the Node-library
  // lint pass.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/web/**",
      "packages/ide/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
