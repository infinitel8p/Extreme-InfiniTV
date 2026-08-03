// Serves the production build via `astro preview`. Visual regression (`tests/visual`) and
// functional e2e (`tests/e2e`) share this config; each project pins its own `testDir`.
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["html", { open: "never" }], ["list"]],
  expect: {
    toHaveScreenshot: { maxDiffPixels: 64, animations: "disabled" },
  },
  use: {
    baseURL: "http://localhost:4325",
    colorScheme: "dark",
    locale: "en-US",
    timezoneId: "UTC",
    contextOptions: { reducedMotion: "reduce" },
  },
  projects: [
    {
      name: "desktop",
      testDir: "tests/visual",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1300, height: 850 },
      },
    },
    {
      name: "phone",
      testDir: "tests/visual",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "e2e",
      testDir: "tests/e2e",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1300, height: 850 },
      },
    },
  ],
  webServer: {
    command: "pnpm preview --port 4325",
    url: "http://localhost:4325",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
