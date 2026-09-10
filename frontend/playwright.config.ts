import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testIgnore: "**/real-api.spec.ts",
  timeout: 30000,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5178",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5178/",
    reuseExistingServer: !process.env.CI,
  },
  reporter: "list",
});
