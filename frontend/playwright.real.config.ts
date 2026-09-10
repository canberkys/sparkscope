import { defineConfig } from "@playwright/test";

process.env.SPARKSCOPE_REAL_E2E = "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "real-api.spec.ts",
  workers: 1,
  outputDir: "../.runtime/real-e2e-results",
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:8021",
    headless: true,
    // Tests enter disposable secrets; do not persist traces or screenshots.
    screenshot: "off",
    trace: "off",
  },
  webServer: {
    command:
      "cd .. && uv run python scripts/e2e_server.py --manifest .runtime/real-e2e.json",
    url: "http://127.0.0.1:8021/api/v1/health",
    reuseExistingServer: false,
    timeout: 30000,
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "../.runtime/validation/real-e2e.json" }],
  ],
});
