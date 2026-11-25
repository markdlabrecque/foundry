/**
 * Launch one real, isolated `pi` process in RPC mode with the faux provider
 * and the fixture tool. Every Pi user directory (HOME, XDG dirs,
 * PI_CODING_AGENT_DIR, sessions, cwd) lives under a fresh temp root, and the
 * child gets no inherited environment beyond PATH, so no operator state,
 * credential or network is used.
 */
import { spawn } from "node:child_process";
import { Option, Schema } from "effect";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAUX_MODEL, FAUX_PROVIDER } from "./faux-provider.js";
import { FIXTURE_TOOL } from "./fixture-tool.js";

/** Environment variable that overrides the pinned `pi` binary, for tests. */
export const PI_BIN_ENV = "FOUNDRY_PI_BIN";

/** The pinned `pi` entry point, unless `FOUNDRY_PI_BIN` names another. */
export function resolvePiBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PI_BIN_ENV];

  if (override !== undefined && override !== "") {return override;}

  // The package's `exports` hide package.json, so walk up from its entry point.
  let dir = dirname(fileURLToPath(import.meta.resolve(PI_PACKAGE)));

  for (;;) {
    const pkgPath = join(dir, "package.json");

    if (existsSync(pkgPath)) {
      // A manifest of another shape is simply not Pi's.
      const pkg = Option.getOrUndefined(decodeManifest(readFileSync(pkgPath, "utf8")));

      if (pkg?.name === PI_PACKAGE && pkg.bin?.pi) {return join(dir, pkg.bin.pi);}
    }

    const parent = dirname(dir);

    if (parent === dir) {throw new Error(`cannot locate the ${PI_PACKAGE} package root`);}

    dir = parent;
  }
}

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const here = import.meta.dirname;
export const FAUX_PROVIDER_EXTENSION = join(here, "faux-provider.js");
export const FIXTURE_TOOL_EXTENSION = join(here, "fixture-tool.js");

/** One JSON line Pi writes on stdout in RPC mode: a `type` and any other JSON fields. */
export const RpcEvent = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
  Schema.Record(Schema.String, Schema.Json),
]);

export type RpcEvent = typeof RpcEvent.Type;

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RpcEvent));

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.optionalKey(Schema.String),
      bin: Schema.optionalKey(Schema.Struct({ pi: Schema.optionalKey(Schema.String) })),
    }),
  ),
);

export interface FauxPi {
  readonly root: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Every JSON line Pi has written to stdout so far. */
  readonly events: ReadonlyArray<RpcEvent>;
  send(command: Readonly<Record<string, Schema.Json>>): void;
  waitFor(match: (event: RpcEvent) => boolean, timeoutMs?: number): Promise<RpcEvent>;
  /** Kill Pi and remove the temp root. */
  dispose(): Promise<void>;
}

export interface StartFauxPiOptions {
  readonly piBin?: string;
  /** More extension files to load after the faux provider and fixture tool. */
  readonly extensions?: ReadonlyArray<string>;
  /** More tool names to enable besides the fixture tool. */
  readonly tools?: ReadonlyArray<string>;
  /** Extra environment for the child, on top of the isolated one. */
  readonly env?: Readonly<Record<string, string>>;
}

export function startFauxPi(options: StartFauxPiOptions = {}): FauxPi {
  const piBin = options.piBin ?? resolvePiBin();
  const root = mkdtempSync(join(tmpdir(), "foundry-faux-pi-"));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const sessions = join(root, "sessions");
  const work = join(root, "work");

  for (const dir of [home, agentDir, sessions, work]) {mkdirSync(dir, { recursive: true });}

  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false }));

  const args = [
    "--mode", "rpc",
    "--no-extensions",
    "--extension", FAUX_PROVIDER_EXTENSION,
    "--extension", FIXTURE_TOOL_EXTENSION,
    ...(options.extensions ?? []).flatMap((path) => ["--extension", path]),
    "--provider", FAUX_PROVIDER,
    "--model", FAUX_MODEL,
    "--tools", [FIXTURE_TOOL, ...(options.tools ?? [])].join(","),
    "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-approve", "--offline",
    "--session-dir", sessions,
  ];

  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ...options.env,
  };

  const isJs = /\.[cm]?js$/.test(piBin);

  const child = spawn(isJs ? process.execPath : piBin, isJs ? [piBin, ...args] : args, {
    cwd: work,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: Array<RpcEvent> = [];
  const waiters: Array<{ match: (e: RpcEvent) => boolean; resolve: (e: RpcEvent) => void }> = [];
  let stderr = "";
  let buffer = "";
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buffer += d;
    let nl: number;

    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (line === "") {continue;}

      // A line that is not a JSON event is skipped, as an unparseable one always was.
      const decoded = decodeEvent(line);

      if (Option.isNone(decoded)) {continue;}

      const event = decoded.value;

      events.push(event);

      for (const w of Array.from(waiters)) {
        if (w.match(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    }
  });

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  return {
    root,
    child,
    events,
    send(command) {
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    waitFor(match, timeoutMs = 30_000) {
      const seen = events.find(match);

      if (seen) {return Promise.resolve(seen);}

      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for a Pi RPC event; stderr:\n${stderr}`)),
          timeoutMs,
        );

        waiters.push({ match, resolve: (e) => { clearTimeout(timer); resolve(e); } });
      });
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin.end();
        child.kill("SIGTERM");
        await exited;
      }

      rmSync(root, { recursive: true, force: true });
    },
  };
}
