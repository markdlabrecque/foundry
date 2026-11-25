# Upstream: anti-slop Oxlint plugins

- **Source:** https://github.com/dmmulroy/anti-slop, the `install-anti-slop` skill's bundled `skills/install-anti-slop/assets/anti-slop/`.
- **Commit:** `63dbb09f73438e550a6991dc6d778f979ffbf183`.
- **Copied with:** the skill's `scripts/install.mjs`, which copies its assets unchanged. At install time, `diff -r` against the skill's assets showed no differences.
- **Pristine snapshot:** `skills/install-anti-slop/assets/anti-slop/` in the upstream repository at the commit above. The skill itself is not kept in this repository.

## Installed plugin paths

| Plugin name in `oxlint.config.ts` | Entry point |
|---|---|
| `anti-slop` | `tools/oxlint/anti-slop/index.ts` |
| `anti-slop-effect` (opt-in; `cli` and `daemon` depend directly on `effect`) | `tools/oxlint/anti-slop/effect/index.ts` |

`vendor/eslint-stylistic/` holds a vendored ESLint Stylistic rule with its own `LICENSE` and `UPSTREAM.md`.

## Local deviations

- **Plugin files:** none. The plugin files are byte-for-byte as copied.
- **Configuration in `oxlint.config.ts`:**
  - `@nkzw/oxlint-config`, pulled in by `@cloudflare/oxlint-config`, bundles an older copy of 12 of these rules (anti-slop `13909c9`) as `quality/*`. Those copies are turned off so each finding is reported once, by this newer copy.
  - `unicorn/catch-error-name` also accepts `cause`, because `no-unknown-parameters` allows an `unknown` parameter only under that name.

## Updating

Install the skill temporarily with `npx skills add dmmulroy/anti-slop --skill install-anti-slop`, then follow its `references/update.md`. Treat an update as a reviewed merge, not a directory replacement, and update the commit above to match. Remove the skill again afterwards.
