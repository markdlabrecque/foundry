/**
 * Disposable Worker Host fixtures: a stub Pi executable for `FOUNDRY_PI_BIN`, and a way to stop
 * the detached host a daemon run leaves behind (PRD §3.2: only `foundry shutdown` stops it).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectHost } from "@foundry/host";

/** File the stub writes in its launch folder: its argv and launch identity. */
export const STUB_PI_RECORD = "stub-pi.json";

const STUB_PI = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(STUB_PI_RECORD)}, JSON.stringify({
  argv: process.argv.slice(2),
  factoryId: process.env.FOUNDRY_FACTORY_ID,
  slotId: process.env.FOUNDRY_SLOT,
  launchId: process.env.FOUNDRY_LAUNCH_ID,
}));
setInterval(() => {}, 60_000);
`;

/**
 * Writes a stub Pi executable into `dir` and returns its path, for `FOUNDRY_PI_BIN`. It records
 * how it was launched in its cwd, then idles until it is signalled; it never starts Pi.
 */
export const writeStubPi = (dir: string): string => {
  const path = join(dir, "stub-pi.cjs");
  writeFileSync(path, STUB_PI);

  return path;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

/**
 * Stops the Worker Host serving `stateRoot`, after it terminates every live launch it owns.
 * Does nothing when no host answers.
 */
export const stopHost = async (stateRoot: string): Promise<void> => {
  let host;

  try {
    host = await connectHost(stateRoot);
  } catch {
    return;
  }

  try {
    for (const launch of await host.inventory()) {
      if (launch.liveness === "live") {await host.terminate(launch.launchId, { graceMs: 0 });}
    }

    const { pid } = await host.identify();
    process.kill(pid, "SIGTERM");

    for (let waited = 0; isAlive(pid) && waited < 5000; waited += 50) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
    }
  } finally {
    host.close();
  }
};
