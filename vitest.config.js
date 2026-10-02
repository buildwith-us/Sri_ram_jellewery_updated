import { defineConfig } from "vitest/config";

// Server-side test suite. Kept separate from vite.config.js so the React
// plugin and dev-server proxy never load for API tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.js", "tests/api/**/*.test.js", "tests/bugs/**/*.test.js"],
    globalSetup: ["tests/setup/globalSetup.js"],
    setupFiles: ["tests/setup/testEnv.js"],
    // Forks, not threads: each file gets its own process, so its own module
    // graph, rate-limiter stores and mongoose connection.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      include: ["server/**/*.js", "shared/**/*.js"],
      exclude: ["server/scripts/**"],
      reporter: ["text-summary", "text", "json-summary", "html"],
      reportsDirectory: "coverage",
    },
  },
});
