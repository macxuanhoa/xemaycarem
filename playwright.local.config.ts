import { defineConfig } from "@playwright/test";

// Temporary local runner: uses a spare port so an already-running dev server
// on 4184 is not disturbed, and injects the mock Supabase URL the E2E tests
// intercept.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4199",
    viewport: { width: 1440, height: 960 },
    screenshot: "only-on-failure",
    trace: "off",
    serviceWorkers: "block",
  },
  webServer: {
    command: "npm run dev -- --port 4199 --strictPort",
    url: "http://127.0.0.1:4199",
    reuseExistingServer: true,
    timeout: 60000,
    env: {
      VITE_SUPABASE_URL: "https://xe-test.supabase.co",
      VITE_SUPABASE_ANON_KEY: "e2e-public-placeholder",
      VITE_ENABLE_PASSWORD_RESET: "false",
    },
  },
});
