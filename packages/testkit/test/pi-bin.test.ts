import { existsSync } from "node:fs";
import { expect, test } from "vitest";
import { PI_BIN_ENV, resolvePiBin } from "@foundry/testkit";

test("FOUNDRY_PI_BIN overrides the pinned pi binary", () => {
  expect(resolvePiBin({ [PI_BIN_ENV]: "/opt/pi/bin/pi" })).toBe("/opt/pi/bin/pi");
});

test("without an override, resolves the pinned pi-coding-agent bin entry", () => {
  const bin = resolvePiBin({});
  expect(bin).toMatch(/@earendil-works\/pi-coding-agent\/dist\/bundle\/cli\.js$/);
  expect(existsSync(bin)).toBe(true);
});
