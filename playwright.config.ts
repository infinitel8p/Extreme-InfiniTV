// Visual-regression suite. Serves the production build (`pnpm build` first) via `astro preview`.
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "tests/visual",
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
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1300, height: 850 },
      },
    },
    {
      name: "phone",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
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
