import js from "@eslint/js";
import tseslint from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "supabase/functions/**",
      "src/types/database.generated.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": hooks },
    rules: { ...hooks.configs.recommended.rules },
  },
  {
    files: [
      "**/*.{js,mjs}",
      "vite.config.ts",
      "playwright.config.ts",
      "tests/**",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/e2e/**/*.mjs", "scripts/check-pwa.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
