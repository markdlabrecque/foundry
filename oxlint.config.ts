import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

// Cloudflare's preset, plus the vendored anti-slop plugins in tools/oxlint/anti-slop
// (see its UPSTREAM.md). The Effect rules apply because cli and daemon depend on effect.
export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  options: { typeAware: true },
  ignorePatterns: [
    ...cloudflare.ignorePatterns,
    "**/dist/**",
    ".scratch/**",
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".claude-plugin/**",
    ".codex/**",
    ".pi/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    {
      name: "anti-slop-effect",
      specifier: "./tools/oxlint/anti-slop/effect/index.ts",
    },
  ],
  rules: {
    // nkzw bundles an older copy of 12 anti-slop rules as `quality/*`. The vendored
    // anti-slop plugin is newer and pinned, so it owns these rules and the copies are off.
    "quality/no-array-filter-map": "off",
    "quality/no-chained-type-assertions": "off",
    "quality/no-conditional-empty-object-spread": "off",
    "quality/no-known-value-widening": "off",
    "quality/no-object-parameters": "off",
    "quality/no-reduce-accumulator-copy": "off",
    "quality/no-reflect-apply": "off",
    "quality/no-reflect-get": "off",
    "quality/no-unknown-returns": "off",
    "quality/no-unknown-type-aliases": "off",
    "quality/no-unsafe-dictionary-type": "off",
    "quality/no-widen-then-assert": "off",

    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
    "anti-slop-effect/no-manual-effect-error-tag": "error",
    "anti-slop-effect/no-manual-tag-comparison": "error",
    "anti-slop-effect/no-manual-tagged-construction": "error",
    "anti-slop-effect/no-service-constructor-imports": "error",
    "anti-slop-effect/prefer-effect-match": "error",
  },
});
