import { defineConfig } from "vitest/config";

// Commit tier: unit and integration tests. Package tests import each package by
// its name, so they run against the built `dist` output (`npm run build` first).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // Integration tests start the built daemon and CLI several times per test; each start already
    // allows 20 s. Vitest's 5 s default is shorter than one slow start on a CI runner.
    testTimeout: 20_000,
  },
});
