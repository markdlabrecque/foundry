/**
 * The neutral Pi RPC launch command (PRD §3.2 "How a worker is launched", §14).
 *
 * A pure mapping from a slot's effective station inputs to the exact argv, cwd and
 * environment the Worker Host spawns. It never spawns Pi and never reads the
 * filesystem, so it is proved by unit tests alone.
 */
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_TOOLS, isPlainToolName, LAUNCH_ENV } from "@foundry/protocol";

// The fixed tools live in @foundry/protocol, shared with the daemon and the extension.
export { AGENT_TOOLS, FIXED_TOOLS, PI_BUILTIN_TOOLS } from "@foundry/protocol";

// Launch identity variables live in @foundry/protocol too: the extension reads them.
export { LAUNCH_ENV } from "@foundry/protocol";

/** Environment variable overriding the pinned Pi executable, for tests (P0 build plan). */
export const PI_BIN_ENV = "FOUNDRY_PI_BIN";

/**
 * Flags that stop Pi loading anything the operator or a repository supplies ambiently.
 * Explicit `--extension`/`--skill` paths still load with these set.
 *
 * The empty `--system-prompt` and `--append-system-prompt` stop Pi 1.6.0 discovering
 * `<agentDir>/SYSTEM.md` and `APPEND_SYSTEM.md`, which load regardless of every other
 * flag here (`--no-approve` only blocks the project copies). Pi resolves `""` to no
 * custom prompt, so the worker still gets Pi's default coding prompt, not an empty one
 * (confirmed in Pi 1.6.0's resource loader and system-prompt builder).
 */
export const SUPPRESSION_FLAGS: ReadonlyArray<string> = [
  "--system-prompt",
  "", // skip global/project SYSTEM.md discovery; falls back to Pi's default prompt
  "--append-system-prompt",
  "", // skip global/project APPEND_SYSTEM.md discovery
  "--no-extensions", // global/project/package extensions and Pi's built-in extensions (codemode, tool search, MCP)
  "--no-mcp", // MCP servers and their tools, even if discovery changes
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files", // AGENTS.md / CLAUDE.md, global and repository
  "--no-approve", // ignore project-local `.pi` resources
];

/** A configured extension and the tools the YAML names on it (PRD §4). */
export interface ConfiguredExtension {
  /** Absolute path, already resolved from the YAML's directory. */
  readonly path: string;
  /** Exact tool names; empty means hooks only. */
  readonly tools: ReadonlyArray<string>;
}

/** The effective station inputs for one launch of one slot. */
export interface LaunchInputs {
  /** Explicit `provider/model` selector, placeholders already resolved. */
  readonly model: string;
  /** Effective skill paths, absolute, in configured order. */
  readonly skills: ReadonlyArray<string>;
  /** Effective extensions, absolute paths, in configured order. */
  readonly extensions: ReadonlyArray<ConfiguredExtension>;
  /** Absolute path of the Foundry Pi extension entry point. */
  readonly foundryExtension: string;
  /** Neutral per-slot folder under the state root; the worker's cwd. */
  readonly slotDir: string;
  readonly factoryId: string;
  readonly slotId: string;
  /**
   * The slot's conversation, which outlives a launch (PRD §5.3, §10.2). Every launch of the slot
   * opens it with `--session-id`, so Pi reopens the slot folder's session with this ID, or starts
   * it with this ID when none exists yet.
   */
  readonly conversationRef: string;
  readonly launchId: string;
}

/** How to start the pinned Pi: an executable plus any leading arguments. */
export interface PiExecutable {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The inputs for a slot's launch before the host issues its launch ID. The host sets the
 * identity variables itself (`LAUNCH_ENV`), so the daemon builds a launch spec from these.
 */
export type SlotLaunchInputs = Omit<LaunchInputs, "launchId">;

/** The executable, argv and cwd of a slot's launch; identity travels in the environment. */
export interface LaunchArgs {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
}

/** Everything `child_process.spawn` needs for one worker launch. */
export interface LaunchCommand extends LaunchArgs {
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Resolves the pinned Pi: `FOUNDRY_PI_BIN` when set, otherwise the pinned package's
 * RPC entry run by this Node.
 *
 * Rule shared with the testkit's `resolvePiBin`/`startFauxPi`: an override ending in
 * `.js`, `.mjs` or `.cjs` runs through this Node (`process.execPath`); any other
 * override is executed directly.
 */
export function resolvePiExecutable(env: Readonly<Record<string, string | undefined>>): PiExecutable {
  const override = env[PI_BIN_ENV];

  if (override !== undefined && override !== "") {
    return /\.[cm]?js$/.test(override)
      ? { command: process.execPath, args: [override] }
      : { command: override, args: [] };
  }

  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

  return { command: process.execPath, args: [entry] };
}

/** Explicit trial selector. RPC remains the default; neither route is qualified here. */
export const WORKER_RUNTIME_ENV = "FOUNDRY_WORKER_RUNTIME";

export function resolveWorkerExecutable(env: Readonly<Record<string, string | undefined>>): PiExecutable {
  const runtime = env[WORKER_RUNTIME_ENV];

  if (runtime === undefined || runtime === "" || runtime === "rpc") {return resolvePiExecutable(env);}

  if (runtime !== "sdk") {throw new Error(`unknown Foundry worker runtime: ${runtime}`);}

  if (env[PI_BIN_ENV]) {throw new Error("FOUNDRY_PI_BIN cannot override the SDK adapter");}

  // The SDK entry accepts the exact resource argv built below, but starts no RPC server.
  return { command: process.execPath, args: [fileURLToPath(new URL("./sdk-worker.js", import.meta.url))] };
}

/** Builds the literal launch command. Throws on inputs that cannot map to argv safely. */
export function buildLaunchCommand(
  inputs: LaunchInputs,
  pi: PiExecutable,
  hostEnv: Readonly<Record<string, string | undefined>>,
): LaunchCommand {
  const launch = buildLaunchArgs(inputs, pi);
  requireValue("launchId", inputs.launchId);

  // The host's full environment, unfiltered (an allowlist is P1); identity always wins
  // over any inherited value, e.g. when the host itself was started from a worker.
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(hostEnv)) {
    if (value !== undefined) {env[name] = value;}
  }

  env[LAUNCH_ENV.factoryId] = inputs.factoryId;
  env[LAUNCH_ENV.slotId] = inputs.slotId;
  env[LAUNCH_ENV.launchId] = inputs.launchId;

  return { ...launch, env };
}

/**
 * Builds a slot launch's executable, argv and cwd, which do not depend on the launch ID.
 * Throws on inputs that cannot map to argv safely.
 */
export function buildLaunchArgs(inputs: SlotLaunchInputs, pi: PiExecutable): LaunchArgs {
  requireValue("model", inputs.model);
  requireAbsolute("slotDir", inputs.slotDir);
  requireAbsolute("foundryExtension", inputs.foundryExtension);

  for (const skill of inputs.skills) {requireAbsolute("skill", skill);}

  for (const extension of inputs.extensions) {
    requireAbsolute("extension", extension.path);

    for (const tool of extension.tools) {requireToolName(tool);}
  }

  requireValue("factoryId", inputs.factoryId);
  requireValue("slotId", inputs.slotId);
  requireSessionId(inputs.conversationRef);

  const tools = [...FIXED_TOOLS, ...inputs.extensions.flatMap((extension) => extension.tools)];

  const args = [
    ...pi.args,
    // Passed even though the default `rpc-entry` already prepends `--mode rpc` (so it
    // appears twice there, harmlessly): a `FOUNDRY_PI_BIN` override is a plain `pi`.
    "--mode",
    "rpc",
    ...SUPPRESSION_FLAGS,
    "--session-id",
    inputs.conversationRef,
    "--model",
    inputs.model,
    "--tools",
    tools.join(","),
    "--extension",
    inputs.foundryExtension,
    ...inputs.extensions.flatMap((extension) => ["--extension", extension.path]),
    ...inputs.skills.flatMap((skill) => ["--skill", skill]),
  ];

  return { command: pi.command, args, cwd: inputs.slotDir };
}

function requireValue(field: string, value: string): void {
  if (value === "" || value.startsWith("-")) {
    throw new Error(`launch input ${field} must be non-empty and not start with "-": ${JSON.stringify(value)}`);
  }
}

/** Pi 1.6.0's own session ID rule, so Pi never refuses the launch for its conversation. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function requireSessionId(ref: string): void {
  if (!SESSION_ID.test(ref)) {
    throw new Error(`launch input conversationRef must be a Pi session ID: ${JSON.stringify(ref)}`);
  }
}

function requireAbsolute(field: string, path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`launch input ${field} must be an absolute path: ${JSON.stringify(path)}`);
  }
}

function requireToolName(name: string): void {
  if (!isPlainToolName(name)) {
    throw new Error(`launch input tool name must be a plain name: ${JSON.stringify(name)}`);
  }
}
