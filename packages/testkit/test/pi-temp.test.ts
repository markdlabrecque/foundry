import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startFauxPi } from "@foundry/testkit";

// One cheap subprocess-boundary check: no actual Pi/model/daemon is needed to
// prove its launch environment and disposable-directory ownership.
const piBin = join(import.meta.dirname, "fixtures", "report-temp.mjs");

test("child temp defaults to an owned directory removed on disposal", async () => {
  const pi = startFauxPi({ piBin });
  const owned = join(pi.root, "tmp");

  try {
    expect(await pi.waitFor((event) => event.type === "temp")).toEqual({ type: "temp", path: owned });
    expect(existsSync(owned)).toBe(true);
  } finally {
    await pi.dispose();
  }

  expect(existsSync(pi.root)).toBe(false);
});

test("caller fixture TMPDIR reaches child and remains caller-owned", async () => {
  const callerTemp = mkdtempSync(join(tmpdir(), "fpi-"));
  const pi = startFauxPi({ piBin, env: { TMPDIR: callerTemp } });

  try {
    expect(await pi.waitFor((event) => event.type === "temp")).toEqual({ type: "temp", path: callerTemp });
    expect(pi.root.startsWith(`${callerTemp}/`)).toBe(true);
    await pi.dispose();
    expect(existsSync(pi.root)).toBe(false);
    expect(existsSync(callerTemp)).toBe(true);
  } finally {
    await pi.dispose();
    rmSync(callerTemp, { recursive: true, force: true });
  }
});
