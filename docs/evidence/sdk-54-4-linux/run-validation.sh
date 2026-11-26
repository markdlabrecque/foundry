#!/usr/bin/env bash
# FOU-155 temporary environment workaround only; unchanged pinned Pi and tests.
# Run from repository root. Output directory must be explicit. No global caches touched.
set -eu
out=$(realpath -m "${1:?output directory required}")
repo=$PWD
mkdir -p "$out"
short=$(mktemp -d "$HOME/f155-XXXXXX")
trap 'rm -rf "$short"' EXIT
mkdir "$short/pi"
node=$(command -v node)
# The testkit deliberately drops outer TMPDIR. Set it inside the child launcher.
printf '#!/bin/sh\nexport TMPDIR="%s/pi"\nexec "%s" "%s/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n' "$short" "$node" "$repo" > "$short/pi-shim"
chmod +x "$short/pi-shim"
cp "$short/pi-shim" "$out/effective-pi-shim.sh"
export TMPDIR="$short"
export FOUNDRY_PI_BIN="$short/pi-shim"
printf 'TMPDIR=%s\nFOUNDRY_PI_BIN=%s\n' "$TMPDIR" "$FOUNDRY_PI_BIN" > "$out/environment.txt"
failed=0
run() {
  name=$1
  shift
  code=0
  "$@" > "$out/$name.log" 2>&1 || code=$?
  printf '%s exit %s\n' "$name" "$code" | tee -a "$out/exits.txt"
  if [ "$code" != 0 ]; then failed=1; fi
}
: > "$out/exits.txt"
run build npm run build
run typecheck npm run typecheck
run oxlint ./node_modules/.bin/oxlint
run interrupt ./node_modules/.bin/vitest run --config vitest.e2e.config.ts packages/extension/e2e/interrupt.e2e.test.ts
run vitest ./node_modules/.bin/vitest run
run e2e ./node_modules/.bin/vitest run --config vitest.e2e.config.ts
exit "$failed"
