/**
 * `foundry slot list | show | interrupt | unfreeze <station/ordinal>` (PRD §11.1–§11.3): one call each over
 * the management socket. Parsing the command line belongs to `main.ts`; this module takes parsed
 * options and returns what to print and the exit code (PRD §11.5).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import {
  isSlotInterruptResult,
  isSlotListResult,
  isSlotShowResult,
  isSlotUnfreezeResult,
  parseSlotId,
  SLOT_INTERRUPT_ACK_TIMEOUT_MS,
  slotInterruptPath,
  slotPath,
  slotResetPath,
  slotRestartPath,
  slotsPath,
  slotUnfreezePath,
} from "@foundry/protocol/slots-api";
import type { SlotInterruptResult, SlotLaunch, SlotListResult, SlotShowResult, SlotSummary, SlotUnfreezeResult } from "@foundry/protocol/slots-api";
import { DaemonUnreachableError, getFromDaemon, postToDaemon } from "./management-client.js";
import type { ApiReply } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface SlotOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The `--factory` flag; required only when more than one factory is loaded. */
  readonly factory: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type SlotOutcome = StatusOutcome;

const refused = (message: string): SlotOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });
const usage = (message: string): SlotOutcome => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${message}\n` });

const launchState = (launch: SlotLaunch | null): string => {
  if (launch === null) {return "no launch";}

  if (launch.endedAt === null) {return `launch ${launch.launchId} live (pid ${launch.pid})`;}

  return `launch ${launch.launchId} ended (${launch.endReason ?? "unknown"})`;
};

/** The condition, with its cause when frozen. */
const conditionOf = (slot: SlotSummary): string =>
  slot.freezeCause === null ? slot.condition : `${slot.condition} (${slot.freezeCause})`;

const listLine = (slot: SlotSummary): string =>
  `${slot.factoryId}  ${slot.slotId}  ${slot.station}  ${conditionOf(slot)}  ${launchState(slot.launch)}`;

const renderList = ({ slots }: SlotListResult): string =>
  slots.length === 0 ? "no slots\n" : `${slots.map(listLine).join("\n")}\n`;

const exitOf = (launch: SlotLaunch): string => {
  if (launch.endedAt === null) {return "live";}

  const how = launch.exitSignal === null ? `code ${launch.exitCode ?? "none"}` : `signal ${launch.exitSignal}`;

  return `ended ${launch.endedAt} (${launch.endReason ?? "unknown"}, ${how})`;
};

const renderShow = ({ slot, launches }: SlotShowResult): string => {
  const lines = [
    `slot        ${slot.slotId}`,
    `factory     ${slot.factoryId}`,
    `station     ${slot.station}`,
    `condition   ${conditionOf(slot)}`,
    "launches",
  ];

  if (launches.length === 0) {lines.push("  none");}

  for (const launch of launches) {
    lines.push(`  ${launch.launchId}  ${launch.origin}  started ${launch.startedAt}  pid ${launch.pid}  ${exitOf(launch)}`);

    if (launch.stderrPath !== null) {lines.push(`    stderr ${launch.stderrPath}`);}
  }

  return `${lines.join("\n")}\n`;
};

const renderInterrupt = ({ launchId, outcome, slot }: SlotInterruptResult): string =>
  outcome === "aborted"
    ? `slot ${slot.slotId}: run aborted; launch ${launchId} and its conversation kept\n`
    : `slot ${slot.slotId}: no run was active; launch ${launchId} and its conversation kept\n`;

const renderUnfreeze = ({ slot, resolvedHold }: SlotUnfreezeResult): string =>
  resolvedHold === null ? `slot ${slot.slotId} unfrozen\n` : `slot ${slot.slotId} unfrozen; hold ${resolvedHold} resolved\n`;

/** The daemon's wait for the worker's acknowledgement, plus time for the call itself. */
const INTERRUPT_TIMEOUT_MS = SLOT_INTERRUPT_ACK_TIMEOUT_MS + 5000;

/** Calls the daemon and renders its result once `is` confirms the shape the daemon answered with. */
const fetchAndRender = async <A>(
  options: SlotOptions,
  path: string,
  is: (value: unknown) => value is A,
  render: (result: A) => string,
  call: (stateRoot: string, path: string) => Promise<ApiReply> = getFromDaemon,
): Promise<SlotOutcome> => {
  if (options.home === "") {return usage("--home needs a directory");}

  if (options.factory === "") {return usage("--factory needs a name");}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await call(stateRoot, path);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }

    return refused(messageOf(error));
  }

  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;

    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }

  if (!reply.envelope.ok) {return refused(reply.envelope.error.message);}

  const result = reply.envelope.result;

  if (!is(result)) {return refused("the daemon answered with an unexpected shape");}

  return { exitCode: EXIT_OK, stdout: render(result), stderr: "" };
};

/** Restart retains the conversation and waits for host-confirmed process-group termination. */
export const runSlotRestart = async (options: SlotOptions & { readonly slot: string }): Promise<SlotOutcome> => {
  if (parseSlotId(options.slot) === undefined) {return usage(`a slot is addressed as station/ordinal, not ${JSON.stringify(options.slot)}`);}

  return fetchAndRender(options, slotRestartPath(options.slot, options.factory), isSlotShowResult,
    ({ slot }) => `slot ${slot.slotId} restarted; conversation kept\n`,
    (root, path) => postToDaemon(root, path, {}, { timeoutMs: 60_000 }));
};

/** Reset is destructive to the conversation; force explicitly accepts unknown old ownership. */
export const runSlotReset = async (options: SlotOptions & { readonly slot: string; readonly force: boolean }): Promise<SlotOutcome> => {
  if (parseSlotId(options.slot) === undefined) {return usage(`a slot is addressed as station/ordinal, not ${JSON.stringify(options.slot)}`);}

  return fetchAndRender(options, slotResetPath(options.slot, options.factory), isSlotShowResult,
    ({ slot }) => `slot ${slot.slotId} reset; fresh conversation started\n`,
    (root, path) => postToDaemon(root, path, { force: options.force }, { timeoutMs: 60_000 }));
};

/** `foundry slot list`: every configured slot with its condition and latest launch. */
export const runSlotList = (options: SlotOptions): Promise<SlotOutcome> =>
  fetchAndRender(options, slotsPath(options.factory), isSlotListResult, renderList);

/** `foundry slot show <station/ordinal>`: one slot and its launch history. */
export const runSlotShow = async (options: SlotOptions & { readonly slot: string }): Promise<SlotOutcome> => {
  if (parseSlotId(options.slot) === undefined) {
    return usage(`a slot is addressed as station/ordinal, not ${JSON.stringify(options.slot)}`);
  }

  return fetchAndRender(options, slotPath(options.slot, options.factory), isSlotShowResult, renderShow);
};

/** `foundry slot interrupt <station/ordinal>`: abort the worker's current run, keeping its launch. */
export const runSlotInterrupt = async (options: SlotOptions & { readonly slot: string }): Promise<SlotOutcome> => {
  if (parseSlotId(options.slot) === undefined) {
    return usage(`a slot is addressed as station/ordinal, not ${JSON.stringify(options.slot)}`);
  }

  return fetchAndRender(
    options,
    slotInterruptPath(options.slot, options.factory),
    isSlotInterruptResult,
    renderInterrupt,
    (stateRoot, path) => postToDaemon(stateRoot, path, {}, { timeoutMs: INTERRUPT_TIMEOUT_MS }),
  );
};

/**
 * `foundry slot unfreeze <station/ordinal>`: the daemon re-runs the check that froze the slot and
 * unfreezes it only if the check passes; otherwise it is refused (exit 1) and stays frozen.
 */
export const runSlotUnfreeze = async (options: SlotOptions & { readonly slot: string }): Promise<SlotOutcome> => {
  if (parseSlotId(options.slot) === undefined) {
    return usage(`a slot is addressed as station/ordinal, not ${JSON.stringify(options.slot)}`);
  }

  return fetchAndRender(
    options,
    slotUnfreezePath(options.slot, options.factory),
    isSlotUnfreezeResult,
    renderUnfreeze,
    (stateRoot, path) => postToDaemon(stateRoot, path, {}),
  );
};
