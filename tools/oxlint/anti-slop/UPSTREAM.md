# Upstream: anti-slop Oxlint plugins

- **Source:** https://github.com/dmmulroy/anti-slop, the `install-anti-slop` skill's bundled `assets/anti-slop/`.
- **Commit:** `63dbb09f73438e550a6991dc6d778f979ffbf183`, as pinned in the repo's `skills-lock.json` (`computedHash` `3d0294ca7cca885e1c676fe52ca49f127089ec7aa6e6e3e5fb2d9a38333ad1b3`).
- **Copied with:** `node .agents/skills/install-anti-slop/scripts/install.mjs`, which copies the skill's assets unchanged.
- **Pristine snapshot:** `.agents/skills/install-anti-slop/assets/anti-slop/`. At install time, `diff -r` against this directory showed no differences.

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

Follow `.agents/skills/install-anti-slop/references/update.md`. Treat an update as a reviewed merge, not a directory replacement, and update the commit above to match.
