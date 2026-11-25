/**
 * Worker Host process entry: `node main.js <state-root>`.
 * Started detached by `startHost`; prints one ready line with its identity on
 * stdout, then closes stdout so it holds nothing of its starter.
 */
import { serveHost } from "./server.js";

const stateRoot = process.argv[2];
if (stateRoot === undefined || stateRoot === "") {
  process.stderr.write("usage: main.js <state-root>\n");
  process.exit(2);
}

const host = await serveHost(stateRoot);

const stop = (): void => {
  void host.close().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
// Losing the starter or its terminal is not a reason to stop.
process.on("SIGHUP", () => {});

process.stdout.on("error", () => {});
process.stdout.write(`${JSON.stringify({ ready: true, identity: host.identity })}\n`, () => {
  process.stdout.destroy();
});
process.stderr.write(`worker host ${host.identity.hostId} serving ${host.socketPath}\n`);
