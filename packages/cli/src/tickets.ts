/**
 * `foundry ticket submit | list | show` (PRD §11.1): one management API call each. Parsing the
 * command line belongs to `main.ts`; this module takes parsed options and returns what to print
 * and the exit code (PRD §11.5). The CLI reads the submitted file and sends its text; the daemon
 * writes the ticket directory.
 */
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { selectStateRoot } from "@foundry/protocol/state-root";
import {
  FACTORY_PARAM,
  isTicketDetail,
  isTicketListResult,
  ticketPath,
  TICKETS_PATH,
  type SubmitTicketRequest,
  type TicketDetail,
  type TicketListResult,
  type TicketPosition,
} from "@foundry/protocol/tickets-api";
import { DaemonUnreachableError, getFromDaemon, postToDaemon, type ApiReply } from "./management-client.js";
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, EXIT_USAGE, type StatusOutcome } from "./status.js";

export type TicketOutcome = StatusOutcome;

interface Common {
  readonly json: boolean;
  readonly home: string | undefined;
  readonly factory: string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface SubmitOptions extends Common {
  readonly file: string;
  readonly title: string | undefined;
  readonly line: string | undefined;
}

export interface ShowOptions extends Common {
  readonly number: number;
}

const usage = (message: string): TicketOutcome => ({ exitCode: EXIT_USAGE, stdout: "", stderr: `foundry: ${message}\n` });
const refused = (message: string): TicketOutcome => ({ exitCode: EXIT_REFUSED, stdout: "", stderr: `foundry: ${message}\n` });

const query = (factory: string | undefined): string =>
  factory === undefined ? "" : `?${FACTORY_PARAM}=${encodeURIComponent(factory)}`;

/** The generic top heading of a PRD §8.3 specification; it names no ticket. */
const GENERIC_HEADING = "Specification";

/**
 * Title from the file's first Markdown heading other than "Specification", else its name
 * without the extension.
 */
export const defaultTitle = (file: string, spec: string): string => {
  for (const match of spec.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const heading = match[1]?.trim();
    if (heading !== undefined && heading !== "" && heading !== GENERIC_HEADING) return heading;
  }
  return basename(file, extname(file));
};

const position = (p: TicketPosition): string =>
  p.state === "stage" ? `${p.stage} (${p.status})` : p.state;

const renderList = ({ tickets }: TicketListResult): string => {
  if (tickets.length === 0) return "no tickets\n";
  return tickets.map((t) => `${t.factory} #${t.number}  ${position(t)}  ${t.line}  ${t.title}`).join("\n") + "\n";
};

const renderDetail = ({ ticket, transitions }: TicketDetail): string => {
  const lines = [
    `ticket      ${ticket.factory} #${ticket.number} ${ticket.slug}`,
    `title       ${ticket.title}`,
    `line        ${ticket.line}`,
    `position    ${position(ticket)}`,
    `submitted   ${ticket.submittedAt}`,
    `rejections  ${ticket.rejections.spent}/${ticket.rejections.ceiling}`,
    `messages    ${ticket.messages.spent}/${ticket.messages.ceiling}`,
    `directory   ${ticket.directory}`,
    `spec        ${ticket.specPath}`,
    `evidence    ${ticket.evidencePath}`,
    `worktree    ${ticket.worktree === null ? "none" : `${ticket.worktree.path} (${ticket.worktree.branch})`}`,
    "transitions",
    ...transitions.map(
      (t) => `  ${t.at}  ${t.actor}  ${t.from === null ? "submitted" : position(t.from)} -> ${position(t.to)}`,
    ),
  ];
  return lines.join("\n") + "\n";
};

const call = async <T>(
  options: Common,
  request: (stateRoot: string) => Promise<ApiReply>,
  isResult: (value: unknown) => value is T,
  render: (result: T) => string,
): Promise<TicketOutcome> => {
  if (options.home === "") return usage("--home needs a directory");
  if (options.factory === "") return usage("--factory needs a name");
  const stateRoot = selectStateRoot({ home: options.home, env: options.env });
  let reply: ApiReply;
  try {
    reply = await request(stateRoot);
  } catch (error) {
    if (error instanceof DaemonUnreachableError) {
      return { exitCode: EXIT_UNREACHABLE, stdout: "", stderr: `foundry: daemon unreachable: ${error.message}\n` };
    }
    return refused((error as Error).message);
  }
  if (options.json) {
    const stdout = reply.body.endsWith("\n") ? reply.body : `${reply.body}\n`;
    return { exitCode: reply.envelope.ok ? EXIT_OK : EXIT_REFUSED, stdout, stderr: "" };
  }
  if (!reply.envelope.ok) return refused(reply.envelope.error.message);
  if (!isResult(reply.envelope.result)) return refused("the daemon answered with an unexpected shape");
  return { exitCode: EXIT_OK, stdout: render(reply.envelope.result), stderr: "" };
};

export const runTicketSubmit = async (options: SubmitOptions): Promise<TicketOutcome> => {
  if (options.title === "") return usage("--title needs text");
  if (options.line === "") return usage("--line needs a name");
  let spec: string;
  try {
    spec = readFileSync(options.file, "utf8");
  } catch (error) {
    return usage(`cannot read ${options.file}: ${(error as Error).message}`);
  }
  const body: SubmitTicketRequest = {
    title: options.title ?? defaultTitle(options.file, spec),
    spec,
    ...(options.factory === undefined ? {} : { factory: options.factory }),
    ...(options.line === undefined ? {} : { line: options.line }),
  };
  return call(options, (root) => postToDaemon(root, TICKETS_PATH, body), isTicketDetail, renderDetail);
};

export const runTicketList = (options: Common): Promise<TicketOutcome> =>
  call(options, (root) => getFromDaemon(root, `${TICKETS_PATH}${query(options.factory)}`), isTicketListResult, renderList);

export const runTicketShow = (options: ShowOptions): Promise<TicketOutcome> => {
  if (!Number.isSafeInteger(options.number) || options.number < 1) {
    return Promise.resolve(usage("a ticket number is a positive integer"));
  }
  return call(
    options,
    (root) => getFromDaemon(root, `${ticketPath(options.number)}${query(options.factory)}`),
    isTicketDetail,
    renderDetail,
  );
};
