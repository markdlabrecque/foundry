// Integration tier (one real boundary: a spawned child): the ownership guards
// depend on the registry seeing a real leader exit, while an injected group
// probe stands in for pgid reuse, which the kernel cannot be made to do on cue.
import { afterEach, expect, test } from "vitest";
import { createLaunchRegistry } from "@foundry/host";
import type { GroupSignal, LaunchRecord } from "@foundry/host";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {cleanup();}
});

/**
 * A registry whose group probe answers from `fake.alive` and whose real
 * signals are recorded, and forwarded to the real group only if `forward`.
 */
function recordingRegistry(fake: { alive: boolean; forward?: boolean }) {
  const sent: Array<GroupSignal> = [];
  let onProbe: (() => void) | undefined;
  const exits: Array<LaunchRecord> = [];
  let onExit: ((record: LaunchRecord) => void) | undefined;

  const registry = createLaunchRegistry({
    bootId: "boot-test",
    groupWatchMs: 5,
    onExit: (record) => {
      exits.push(record);
      onExit?.(record);
    },
    signalGroup: (pgid, signal) => {
      if (signal === 0) {
        onProbe?.();

        if (fake.forward) {
          try {
            process.kill(-pgid, 0);

            return true;
          } catch {
            return false;
          }
        }

        return fake.alive;
      }

      sent.push(signal);

      if (fake.forward) {process.kill(-pgid, signal);}

      return true;
    },
  });

  return {
    registry,
    sent,
    exited: () =>
      new Promise<LaunchRecord>((resolve) => {
        if (exits.length > 0) {resolve(exits[0] as LaunchRecord);}
        else {onExit = resolve;}
      }),
    nextProbe: () => new Promise<void>((resolve) => { onProbe = () => ((onProbe = undefined), resolve()); }),
  };
}

async function launch(registry: ReturnType<typeof createLaunchRegistry>, script: string): Promise<LaunchRecord> {
  const record = await registry.launch({
    factoryId: "factory-a",
    slotId: "slot-1",
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
  });

  cleanups.push(() => {
    try {
      process.kill(-record.pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  });

  return record;
}

test("a group recorded empty at its leader's exit is never signalled, even if its ID is reused", async () => {
  const fake = { alive: false };
  const { registry, sent, exited } = recordingRegistry(fake);
  const record = await launch(registry, "");
  await exited();

  fake.alive = true; // Another group now holds the same ID.
  const termination = await registry.terminate(record.launchId, { graceMs: 0, killWaitMs: 0 });
  expect(termination).toMatchObject({ outcome: "gone", escalated: false });
  expect(sent).toEqual([]);
});

test("a group outliving its leader is watched until empty, then never signalled", async () => {
  const fake = { alive: true }; // Members remain when the leader exits.
  const { registry, sent, exited, nextProbe } = recordingRegistry(fake);
  const record = await launch(registry, "");
  await exited();

  // The members leave; the next probe from the watcher records the group empty.
  const probed = nextProbe();
  fake.alive = false;
  await probed;

  fake.alive = true; // The ID is reused.
  const termination = await registry.terminate(record.launchId, { graceMs: 0, killWaitMs: 0 });
  expect(termination).toMatchObject({ outcome: "gone", escalated: false });
  expect(sent).toEqual([]);
});

test("concurrent terminations of one launch share a single SIGTERM and result", async () => {
  const { registry, sent } = recordingRegistry({ alive: true, forward: true });
  const record = await launch(registry, "setInterval(() => {}, 1000)");

  const options = { graceMs: 5000, killWaitMs: 5000 };

  const [first, second] = await Promise.all([
    registry.terminate(record.launchId, options),
    registry.terminate(record.launchId, options),
  ]);

  expect(first).toMatchObject({
    outcome: "gone",
    escalated: false,
    launch: { liveness: "gone", exit: { signal: "SIGTERM", requested: true } },
  });
  expect(second).toBe(first);
  expect(sent).toEqual(["SIGTERM"]);
});
