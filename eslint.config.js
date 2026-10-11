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
      "scratch/**",
      "backups/**",
      // Generated Tesseract runtime (scripts/prepare-ocr-assets.mjs): vendored
      // minified WASM loaders, not project source — same class as dist/.
      "public/tesseract/**",
      ".vercel-tmp/**",
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
    files: [
      "tests/e2e/**/*.mjs",
      "tests/helpers/uiux-fixtures.mjs",
      "scripts/check-pwa.mjs",
      "scripts/capture-uiux.mjs",
      "scripts/preview-capture.mjs",
    ],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // MV3 extension: chạy trong trình duyệt (service worker + content script),
    // không phải Node và không phải source của app → khai báo `chrome` tường minh.
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, chrome: "readonly" },
    },
  },
);
