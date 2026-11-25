/**
 * `foundry hold list | show <id>` (PRD §11.1–§11.3): one `GET` each over the management socket.
 * Parsing the command line belongs to `main.ts`; this module takes parsed options and returns
 * what to print and the exit code (PRD §11.5).
 */
import { selectStateRoot } from "@foundry/protocol/state-root";
import { Schema } from "effect";
import { messageOf } from "@foundry/protocol/errors";
import { holdPath, HOLDS_PATH, isHoldListResult, isHoldShowResult } from "@foundry/protocol/holds";
import type { HoldRecord, HoldShowResult } from "@foundry/protocol/holds";
import { DaemonUnreachableError, getFromDaemon } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE } from "./status.js";
import type { StatusOutcome } from "./status.js";

export interface HoldOptions {
  /** Print the API response body unchanged. */
  readonly json: boolean;
  /** The `--home` flag, if given. */
  readonly home: string | undefined;
  /** The process environment; only `FOUNDRY_HOME` is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type HoldOutcome = StatusOutcome;

const refused = (message: string): HoldOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });
const usage = (message: string): HoldOutcome => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${message}\n` });

const listLine = (hold: HoldRecord): string => `${hold.id}  ${hold.kind}  ${hold.subject}  raised ${hold.raisedAt}`;

const renderList = (holds: ReadonlyArray<HoldRecord>): string =>
  holds.length === 0 ? "no open holds\n" : `${holds.map(listLine).join("\n")}\n`;

const renderShow = ({ hold, commands }: HoldShowResult): string => {
  const lines = [
    `hold        ${hold.id}`,
    `kind        ${hold.kind}`,
    `subject     ${hold.subject}`,
    `factory     ${hold.factoryId}`,
    `state       ${hold.state}`,
    `raised at   ${hold.raisedAt}`,
    `updated at  ${hold.updatedAt}`,
  ];

  if (hold.closedAt !== null) {lines.push(`closed at   ${hold.closedAt}`);}

  lines.push("evidence");

  for (const [key, value] of Object.entries(hold.evidence)) {
    lines.push(`  ${key}: ${isText(value) ? value : JSON.stringify(value)}`);
  }

  if (hold.state === "open") {
    lines.push("commands");

    for (const command of commands) {lines.push(`  ${command}`);}
  }

  return `${lines.join("\n")}\n`;
};

const isText = Schema.is(Schema.String);

/** Fetches `path` and renders its result once `is` confirms the shape the daemon answered with. */
const fetchAndRender = async <A>(
  options: HoldOptions,
  path: string,
  is: (value: unknown) => value is A,
  render: (result: A) => string,
): Promise<HoldOutcome> => {
  if (options.home === "") {return usage("--home needs a directory");}

  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply;

  try {
    reply = await getFromDaemon(stateRoot, path);
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

/** `foundry hold list`: the open holds, oldest first. */
export const runHoldList = (options: HoldOptions): Promise<HoldOutcome> =>
  fetchAndRender(options, HOLDS_PATH, isHoldListResult, (result) => renderList(result.holds));

/** `foundry hold show <id>`: one hold's evidence and the commands that act on its subject. */
export const runHoldShow = async (options: HoldOptions & { readonly id: string }): Promise<HoldOutcome> => {
  if (!/^[1-9][0-9]{0,15}$/.test(options.id)) {return usage(`hold ID must be a positive integer, not ${JSON.stringify(options.id)}`);}

  return fetchAndRender(options, holdPath(Number(options.id)), isHoldShowResult, renderShow);
};
