import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: 0,
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: `../bench/reports/v0.4.0-alpha.2/${process.env.CHRONOGRAPH_REPORT_PHASE || "phase-7-ui"}/e2e.json`,
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:18083",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1536, height: 1024 },
      },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "node ../scripts/e2e-server.mjs",
    url: "http://127.0.0.1:18083/healthz",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
