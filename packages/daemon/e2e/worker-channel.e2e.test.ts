// Journey: the built daemon starts a slot, the Worker Host launches the real pinned `pi` with the
// faux provider, and the Foundry extension Pi loads dials the daemon's channel. Proves the wiring
// only (launch environment, extension entry point, channel served at startup, discovery registered
// by the production daemon); claim and discovery scoping rules have cheaper contract tests.
// No cheaper tier loads the extension into a real Pi launch.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { TicketDetail } from "@foundry/protocol/tickets-api";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { Option, Schema } from "effect";
import { daemonLogPath } from "@foundry/daemon";
import { runSlotList } from "@foundry/cli";
import { FAUX_MODEL, FAUX_PROVIDER, FAUX_PROVIDER_EXTENSION, isolatedGitEnv, makeGitSource, stopHost } from "@foundry/testkit";

const daemonMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/daemon"))), "main.js");
const discoveryDriver = join(import.meta.dirname, "fixtures", "discover-worker.ts");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {await cleanup();}
});

const factoryYaml = `version: 1
name: alpha
repository:
  source: ./repo
  default_branch: main
default_production_line: f
rooms:
  eng:
    stations:
      dev:
        isolation: worktree
        model: ${FAUX_PROVIDER}/${FAUX_MODEL}
        extensions: [${JSON.stringify(FAUX_PROVIDER_EXTENSION)}, ${JSON.stringify(discoveryDriver)}]
production_lines:
  f:
    verify: ["true"]
    stages:
      - id: a
        station: eng.dev
        writing: true
      - id: b
        station: eng.dev
        approval: true
        on_rejection: a
`;

const LogLine = Schema.Struct({
  msg: Schema.String,
  factoryId: Schema.optionalKey(Schema.String),
  slotId: Schema.optionalKey(Schema.String),
  launchId: Schema.optionalKey(Schema.String),
});

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(LogLine));

const logLines = (home: string): Array<typeof LogLine.Type> => {
  const path = daemonLogPath(home);

  if (!existsSync(path)) {return [];}

  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    const decoded = decodeLine(line);

    return Option.isSome(decoded) ? [decoded.value] : [];
  });
};

/** Starts the built daemon on `home` with every Pi and user directory under `root`. */
const startDaemon = (root: string, home: string, factory: string): Promise<ChildProcess> => {
  const user = join(root, "user");

  for (const dir of [user, join(root, "agent")]) {mkdirSync(dir, { recursive: true });}

  writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

  // The host and its launches inherit this environment: no operator Pi state, credential or network.
  const child = spawn(process.execPath, [daemonMain, "--home", home, factory], {
    env: {
      ...isolatedGitEnv(),
      HOME: user,
      XDG_CONFIG_HOME: join(user, ".config"),
      XDG_DATA_HOME: join(user, ".local/share"),
      XDG_CACHE_HOME: join(user, ".cache"),
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      FOUNDRY_TEST_DISCOVERY_RESULT: join(root, "discovery-result.json"),
      FOUNDRY_HOME: join(root, "not-this-one"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();

      if (stdout.includes("management API on")) {resolve(child);}
    });
    child.on("exit", (code) => reject(new Error(`daemon exited ${code} before serving: ${stderr}`)));
  });
};

test("a launched faux-provider Pi worker authenticates and discovers its configured station and slot", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-worker-channel-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  // Registered after the root's removal so it runs first: the host stops every launch it owns.
  cleanups.push(() => stopHost(home));
  makeGitSource(join(root, "repo"));
  const factory = join(root, "factory.yaml");
  writeFileSync(factory, factoryYaml);

  await startDaemon(root, home, factory);

  // The slot's launch as the daemon recorded it from the host's start reply.
  const listed = await runSlotList({ json: true, home, factory: undefined, env: { FOUNDRY_HOME: join(root, "not-this-one") } });

  const decodeList = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        result: Schema.Struct({
          slots: Schema.Array(Schema.Struct({ slotId: Schema.String, launch: Schema.NullOr(Schema.Struct({ launchId: Schema.String })) })),
        }),
      }),
    ),
  );

  const [slot] = decodeList(listed.stdout).result.slots;
  const launchId = slot?.launch?.launchId;

  expect(slot?.slotId).toBe("dev/1");
  expect(launchId).toBeDefined();

  // Pi loads the Foundry extension, which dials the channel; the host-confirmed claim accepts it.
  await expect
    .poll(() => logLines(home).filter((l) => l.msg === "channel accepted" || l.msg === "channel hello refused"), {
      timeout: 30_000,
      interval: 200,
    })
    .toEqual([{ msg: "channel accepted", factoryId: "alpha", slotId: "dev/1", launchId }]);

  // Observe Pi's actual tool result, not a separate channel client or a test-owned dispatch map.
  const resultPath = join(root, "discovery-result.json");
  await expect.poll(() => existsSync(resultPath), { timeout: 30_000, interval: 200 }).toBe(true);

  const result = Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({
      toolName: Schema.String,
      isError: Schema.Boolean,
      content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
    })),
  )(readFileSync(resultPath, "utf8"));

  expect(result).toEqual({
    toolName: "agent_discover",
    isError: false,
    content: [{ type: "text", text: JSON.stringify({
      factory: "alpha",
      stations: [{ address: "eng.dev", room: "eng", station: "dev", slots: ["dev/1"] }],
    }) }],
  });
});

// Journey: two real workers remain independent while the operator pauses and resumes one.
// Only the full CLI -> daemon -> host -> Pi -> extension chain can prove this wiring.
test("concurrent tickets keep isolated artifacts and the other Pi progresses during pause/resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "foundry-concurrent-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  cleanups.push(() => stopHost(home));
  makeGitSource(join(root, "repo"));
  const driver = join(import.meta.dirname, "fixtures", "concurrent-worker.ts");
  const factory = join(root, "factory.yaml");
  writeFileSync(factory, factoryYaml
    .replace("        isolation: worktree", "        instances: 2\n        isolation: worktree")
    .replace(JSON.stringify(discoveryDriver), `{ path: ${JSON.stringify(driver)}, tools: [fixture_work] }`));
  await startDaemon(root, home, factory);
  const cliMain = join(dirname(fileURLToPath(import.meta.resolve("@foundry/cli"))), "main.js");

  const cli = async (...args: Array<string>): Promise<string> => {
    const result = await promisify(execFile)(process.execPath, [cliMain, ...args, "--home", home, "--json"], {
      env: { ...isolatedGitEnv(), HOME: join(root, "user"), FOUNDRY_HOME: join(root, "not-this-one") }, timeout: 15_000,
    });

    return result.stdout;
  };

  const detail = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ result: TicketDetail })));
  const show = async (number: number) => detail(await cli("ticket", "show", String(number))).result.ticket;

  for (const number of [1, 2]) {
    const file = join(root, `spec-${number}.md`);
    writeFileSync(file, `# Fixture ${number}\nDisposable concurrent work ${number}.\n`);
    await cli("ticket", "submit", file);
  }

  await expect.poll(async () => (await Promise.all([show(1), show(2)])).map((ticket) => ticket.status), { timeout: 30_000 }).toEqual(["assigned", "assigned"]);
  const [first, second] = await Promise.all([show(1), show(2)]);

  if (!first?.worktree || !second?.worktree) {throw new Error("both tickets need worktrees");}

  expect(first.worktree.path).not.toBe(second.worktree.path);
  expect(first.worktree.branch).not.toBe(second.worktree.branch);
  expect(first.directory).not.toBe(second.directory);

  for (const ticket of [first, second]) {
    await expect.poll(() => existsSync(join(ticket.evidencePath, "started.txt")), { timeout: 30_000 }).toBe(true);

    if (!ticket.worktree) {throw new Error("missing fixture worktree");}

    expect(readFileSync(join(ticket.worktree.path, "started.txt"), "utf8")).toBe(String(ticket.number));
    expect(readFileSync(ticket.specPath, "utf8")).toContain(`Fixture ${ticket.number}`);
  }

  expect(await cli("status")).toContain(home);
  expect(detail(await cli("ticket", "pause", "1")).result.ticket.status).toBe("paused");
  await expect.poll(() => existsSync(join(first.evidencePath, "interrupted.txt"))).toBe(true);
  expect(existsSync(join(second.evidencePath, "interrupted.txt"))).toBe(false);
  // Release only worker 2 *after* the pause completed: progress cannot predate intervention.
  writeFileSync(join(second.evidencePath, "release"), "go");
  await expect.poll(() => existsSync(join(second.evidencePath, "progressed.txt"))).toBe(true);
  expect((await show(1)).status).toBe("paused");
  expect(existsSync(join(first.evidencePath, "progressed.txt"))).toBe(false);
  await cli("ticket", "resume", "1");
  await expect.poll(() => existsSync(join(first.evidencePath, "resumed.txt")), { timeout: 30_000 }).toBe(true);
  expect((await show(1)).worktree).toEqual(first.worktree);
  writeFileSync(join(first.evidencePath, "release"), "go");
  await expect.poll(() => existsSync(join(first.evidencePath, "progressed.txt"))).toBe(true);
  const events = await cli("events", "--ticket", "1", "--factory", "alpha");
  expect(events).toContain('"kind":"ticket.paused"');
  expect(events).toContain('"kind":"ticket.resumed"');

  for (const ticket of [first, second]) {
    expect(readFileSync(join(ticket.evidencePath, "progressed.txt"), "utf8")).toBe(String(ticket.number));
  }
});
