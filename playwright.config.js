const { defineConfig } = require("@playwright/test");

const port = Number(process.env.PORT) || 4173;
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL,
    acceptDownloads: true,
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server.js",
    url: `${baseURL}/login/`,
    reuseExistingServer: Boolean(process.env.E2E_RUN_ID) || !process.env.CI
  }
});
