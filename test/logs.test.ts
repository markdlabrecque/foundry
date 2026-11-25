// Tier: integration. Fixture log files in a disposable state root, read through the real
// management API socket and through the CLI's daemon-down path. The selection logic has no
// cheaper seam worth its own tier: it is a filter over real files, and the claim is that the
// right lines come back over the API and nothing unrelated does.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { DAEMON_LOG_NAME, serveManagementApi } from "@foundry/daemon";
import { HOST_LOG_NAME, launchStderrPath } from "@foundry/host";
import { EXIT_OK, EXIT_USAGE, runLogs } from "@foundry/cli";
import { LOGS_PATH, LogsResult } from "@foundry/protocol/log-query";
import { Schema } from "effect";

const decodeMsg = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ msg: Schema.String })));

const decodeLogsResult = Schema.decodeUnknownSync(LogsResult);

const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

// Socket paths must stay short, so the root is a small temp dir, removed after each test.
const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "foundry-logs-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  return root;
};

// FOUNDRY_HOME is never the operator's root: every call names --home.
const env = { FOUNDRY_HOME: "/nonexistent-foundry-home" };

const line = (msg: string, refs: Record<string, string> = {}): string =>
  JSON.stringify({ time: "2026-01-01T00:00:00.000Z", level: "info", runId: "run-1", msg, ...refs });

/** A state root with a rotated daemon log, a host log and a retained stderr starting mid-character. */
const fixture = (): string => {
  const root = tempRoot();
  mkdirSync(join(root, "logs", "launches"), { recursive: true });
  const daemonLog = join(root, DAEMON_LOG_NAME);
  writeFileSync(
    `${daemonLog}.2`,
    [line("oldest", { factoryId: "f1", slotId: "dev/1", ticketId: "7" }), line("unrelated-a", { factoryId: "f2" })].join("\n") + "\n",
  );
  writeFileSync(`${daemonLog}.1`, [line("middle", { factoryId: "f1", slotId: "dev/2", ticketId: "7" }), "not json"].join("\n") + "\n");
  writeFileSync(
    daemonLog,
    [
      line("newest", { factoryId: "f1", slotId: "dev/1", launchId: "L1", ticketId: "8" }),
      line("unrelated-b", { factoryId: "f1", slotId: "dev/10", ticketId: "77" }),
      line("daemon started"),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(root, HOST_LOG_NAME),
    [line("launch ended unexpectedly", { slotId: "dev/1", launchId: "L1" }), line("host-unrelated", { launchId: "L2" })].join("\n") + "\n",
  );
  // "é" is 0xC3 0xA9: the tail starts on the continuation byte left after the cut.
  writeFileSync(launchStderrPath(root, "L1"), Buffer.concat([Buffer.from([0xa9]), Buffer.from("boom: café\n", "utf8")]));

  return root;
};

const msgs = (lines: ReadonlyArray<string>): Array<string> => lines.map((l) => decodeMsg(l).msg);

const get = (socketPath: string, path: string): Promise<{ status: number; body: any }> =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });

    req.on("error", reject);
    req.end();
  });

test("the logs API selects fixture lines by reference across rotated files, oldest first, and nothing unrelated", async () => {
  const root = fixture();

  const api = await serveManagementApi({
    stateRoot: root,
    status: () => ({ instance: { stateRoot: root, daemonPid: 1, startedAt: "2026-01-01T00:00:00.000Z" } }),
  });

  cleanups.push(() => api.close());

  const logs = async (search: string) => {
    const reply = await get(api.socketPath, `${LOGS_PATH}${search}`);
    expect(reply.status).toBe(200);

    return decodeLogsResult(reply.body.result);
  };

  expect(msgs((await logs("?ticket=7")).lines)).toEqual(["oldest", "middle"]);
  expect(msgs((await logs("?slot=dev%2F1")).lines)).toEqual(["oldest", "newest"]);
  expect(msgs((await logs("?factory=f1&slot=dev%2F1&ticket=8")).lines)).toEqual(["newest"]);
  // Unfiltered keeps every line as written, including one that is not JSON.
  expect((await logs("")).lines).toHaveLength(7);
  expect((await logs("")).lines).toContain("not json");

  // --launch on the host log also returns the retained stderr, minus the cut character.
  const launch = await logs("?host=1&launch=L1");
  expect(launch).toEqual({
    log: "host",
    lines: [expect.stringContaining("launch ended unexpectedly")],
    launchStderr: { launchId: "L1", path: launchStderrPath(root, "L1"), text: "boom: café\n" },
  });

  // A launch ID that could leave logs/launches, or an unknown parameter, is refused.
  for (const bad of ["?launch=..%2Fdaemon.log", "?bogus=1", "?ticket=7&ticket=8"]) {
    expect(await get(api.socketPath, `${LOGS_PATH}${bad}`)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_request" } } });
  }
});

test("foundry logs reads the same selection with the daemon down, and the binary wires it", async () => {
  const root = fixture();
  const out = await runLogs({ host: false, json: false, ticket: "7", home: root, env });
  expect(out.exitCode).toBe(EXIT_OK);
  expect(msgs(out.stdout.trimEnd().split("\n"))).toEqual(["oldest", "middle"]);

  const missing = await runLogs({ host: false, json: false, home: tempRoot(), env });
  expect(missing).toEqual({ exitCode: EXIT_OK, stdout: "", stderr: "" });

  const run = (args: Array<string>) =>
    spawnSync(process.execPath, [cliMain, "logs", ...args], { env: { ...process.env, ...env }, encoding: "utf8", timeout: 20_000 });

  const viaBinary = run(["--host", "--launch", "L1", "--home", root]);
  expect(viaBinary.status).toBe(EXIT_OK);
  expect(viaBinary.stdout).toContain("launch ended unexpectedly");
  expect(viaBinary.stdout).toContain("boom: café");
  expect(viaBinary.stdout).not.toContain("host-unrelated");
  expect(run(["--launch", "../x", "--home", root]).status).toBe(EXIT_USAGE);
  expect(run(["--bogus", "--home", root]).status).toBe(EXIT_USAGE);
});
