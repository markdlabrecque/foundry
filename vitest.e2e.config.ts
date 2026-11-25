import { defineConfig } from "vitest/config";

// End-to-end tier: real pinned `pi` processes with the faux provider. Merge-request
// and nightly only, not on every commit. Run `npm run build` first.
export default defineConfig({
  test: {
    include: ["packages/*/e2e/**/*.e2e.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
