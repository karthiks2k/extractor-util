const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    acceptDownloads: true,
    headless: true,
    trace: "retain-on-failure"
  },
  webServer: {
    command: "node server.js",
    url: "http://127.0.0.1:4173/login/",
    reuseExistingServer: !process.env.CI
  }
});
