// Tier: unit. Process-scoped launch metadata, no Pi, sockets, disk or clocks.
import { expect, test, vi } from "vitest";
import { claimLaunchChannel } from "../src/channel/launch.js";

const reason = { kind: "terminal", code: "launch_not_current", detail: "stale launch" } as const;

test("terminal reason survives module reconstruction but not launch quit, and never poisons another launch", async () => {
  const original = claimLaunchChannel("reload-fixture");
  const stop = vi.fn();
  original.own(stop);
  original.refuse(reason);
  original.release(false);
  expect(stop).toHaveBeenCalledOnce();
  vi.resetModules();
  const reloadedModule = await import("../src/channel/launch.js");
  const reloaded = reloadedModule.claimLaunchChannel("reload-fixture");
  const independent = reloadedModule.claimLaunchChannel("independent-launch");
  expect(reloaded.reason).toEqual(reason);
  expect(independent.reason).toBeUndefined();
  reloaded.release(true);
  independent.release(true);
  const afterQuit = claimLaunchChannel("reload-fixture");
  expect(afterQuit.reason).toBeUndefined();
  afterQuit.release(true);
});

test("replacement owns the only transport and stale owners cannot remove it or poison its refusal state", () => {
  const original = claimLaunchChannel("ownership-fixture");
  const originalStop = vi.fn();
  original.own(originalStop);
  const replacement = claimLaunchChannel("ownership-fixture");
  const replacementStop = vi.fn();
  replacement.own(replacementStop);
  expect(originalStop).toHaveBeenCalledOnce();
  original.refuse(reason);
  original.release(true);
  expect(replacement.reason).toBeUndefined();
  expect(replacementStop).not.toHaveBeenCalled();
  replacement.refuse(reason);
  expect(replacement.reason).toEqual(reason);
  replacement.release(true);
  expect(replacementStop).toHaveBeenCalledOnce();
});
