/**
 * `foundry slot list | show | interrupt <station/ordinal>` (PRD §11.1–§11.3): one call each over
 * the management socket. Parsing the command line belongs to `main.ts`; this module takes parsed
 * options and returns what to print and the exit code (PRD §11.5).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { messageOf } from "@foundry/protocol/errors";
import {
  isSlotInterruptResult,
  isSlotListResult,
  isSlotShowResult,
  parseSlotId,
  slotInterruptPath,
  slotPath,
  slotsPath,
} from "@foundry/protocol/slots-api";
import type { SlotInterruptResult, SlotLaunch, SlotListResult, SlotShowResult, SlotSummary } from "@foundry/protocol/slots-api";
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

const listLine = (slot: SlotSummary): string =>
  `${slot.factoryId}  ${slot.slotId}  ${slot.station}  ${slot.condition}  ${launchState(slot.launch)}`;

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
    `condition   ${slot.condition}`,
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

/** The daemon waits up to 30 s for the worker's acknowledgement; allow for that plus the call. */
const INTERRUPT_TIMEOUT_MS = 35_000;

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
