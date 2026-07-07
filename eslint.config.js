import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // The web app (JSX/DOM) is typechecked by `tsc -p packages/web` and built by
  // Vite; it isn't part of the Node-library lint pass.
  { ignores: ["**/dist/**", "**/node_modules/**", "packages/web/**"] },
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
