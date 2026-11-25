import { defineConfig } from "vitest/config";

// Commit tier: unit and integration tests. Package tests import each package by
// its name, so they run against the built `dist` output (`npm run build` first).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
  },
});
