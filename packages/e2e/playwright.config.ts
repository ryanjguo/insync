import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  timeout: 90_000,
  // One browser with the extension, one Go server: run tests one at a time.
  workers: 1,
  reporter: "list",
});
