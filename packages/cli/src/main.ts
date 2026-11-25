#!/usr/bin/env node
/**
 * The `foundry` entry point. This is the only Foundry module that imports
 * `effect/cli` (PRD §3.1: unstable Effect modules sit behind one module).
 */
import { Console, Effect, Option, Predicate } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { EXIT_USAGE, runStatus } from "./status.js";
import { runLogs } from "./logs.js";
import { runMessageSend } from "./messages.js";
import { validateFactoryFile } from "./validate.js";
import { runTicketList, runTicketPause, runTicketRetry, runTicketShow, runTicketSubmit } from "./tickets.js";
import type { TicketOutcome } from "./tickets.js";
import { runHoldList, runHoldShow } from "./holds.js";
import { runApprovalAnswer, runApprovalDecision, runApprovalList, runApprovalShow } from "./approvals.js";
import type { HoldOutcome } from "./holds.js";
import { runEvents } from "./events.js";
import { runFactoryPath, runFactorySync } from "./factory.js";
import { runFactoryList } from "./factories.js";
import { runWorktreeClean, runWorktreeList } from "./worktrees.js";
import { runFactoryStop } from "./factory-stop.js";
import { runShutdown } from "./shutdown.js";
import { runSlotInterrupt, runSlotList, runSlotReset, runSlotShow, runSlotUnfreeze } from "./slots.js";

const validate = Command.make(
  "validate",
  { file: Argument.String("factory.yaml") },
  ({ file }) =>
    Effect.gen(function* () {
      const outcome = validateFactoryFile(file);

      for (const line of outcome.stdout) {yield* Console.log(line);}

      for (const line of outcome.stderr) {yield* Console.error(line);}

      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Check a factory YAML file offline, without changing anything"));

const status = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the management API response body unchanged"),
    ),
    home: Flag.String("home").pipe(
      Flag.optional,
      Flag.withDescription("State root of the instance (default: FOUNDRY_HOME, else ~/.foundry)"),
    ),
  },
  ({ json, home }) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(() =>
        runStatus({ json, home: Option.getOrUndefined(home), env: process.env }),
      );

      if (outcome.stdout !== "") {process.stdout.write(outcome.stdout);}

      if (outcome.stderr !== "") {process.stderr.write(outcome.stderr);}

      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Show the running instance's status from the daemon"));

const events = Command.make(
  "events",
  {
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print each event's JSON unchanged")),
    follow: Flag.Boolean("follow").pipe(Flag.withDefault(false), Flag.withDescription("Keep printing new events")),
    since: Flag.Int("since").pipe(Flag.optional, Flag.withDescription("Only events after this event ID")),
    ticket: Flag.Int("ticket").pipe(Flag.optional, Flag.withDescription("Only events concerning this ticket")),
    factory: Flag.String("factory").pipe(Flag.optional, Flag.withDescription("Only events of this factory")),
    home: Flag.String("home").pipe(
      Flag.optional,
      Flag.withDescription("State root of the instance (default: FOUNDRY_HOME, else ~/.foundry)"),
    ),
  },
  ({ json, follow, since, ticket, factory, home }) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise((signal) =>
        runEvents({
          json,
          follow,
          since: Option.getOrUndefined(since),
          ticket: Option.getOrUndefined(ticket),
          factory: Option.getOrUndefined(factory),
          home: Option.getOrUndefined(home),
          env: process.env,
          write: (line) => void process.stdout.write(`${line}\n`),
          notice: (line) => void process.stderr.write(`${line}\n`),
          signal,
        }),
      );

      if (outcome.stderr !== "") {process.stderr.write(outcome.stderr);}

      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Print durable factory events, optionally following new ones"));

const commonFlags = {
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print the management API response body unchanged"),
  ),
  home: Flag.String("home").pipe(
    Flag.optional,
    Flag.withDescription("State root of the instance (default: FOUNDRY_HOME, else ~/.foundry)"),
  ),
};

const print = (outcome: HoldOutcome) =>
  Effect.sync(() => {
    if (outcome.stdout !== "") {process.stdout.write(outcome.stdout);}

    if (outcome.stderr !== "") {process.stderr.write(outcome.stderr);}

    process.exitCode = outcome.exitCode;
  });

const approvalList = Command.make("list", commonFlags, ({ json, home }) =>
  Effect.flatMap(Effect.promise(() => runApprovalList({ json, home: Option.getOrUndefined(home), env: process.env })), print),
);

const approvalShow = Command.make("show", { ...commonFlags, id: Argument.String("id") }, ({ json, home, id }) =>
  Effect.flatMap(Effect.promise(() => runApprovalShow({ json, home: Option.getOrUndefined(home), env: process.env, id })), print),
);

const approvalAnswer = Command.make("answer", { ...commonFlags, id: Argument.String("id"), body: Argument.String("text") }, ({ json, home, id, body }) =>
  Effect.flatMap(Effect.promise(() => runApprovalAnswer({ json, home: Option.getOrUndefined(home), env: process.env, id, body })), print),
);

const approvalApprove = Command.make("approve", { ...commonFlags, id: Argument.String("id") }, ({ json, home, id }) =>
  Effect.flatMap(Effect.promise(() => runApprovalDecision({ json, home: Option.getOrUndefined(home), env: process.env, id, decision: "approve" })), print),
);

const approvalReject = Command.make("reject", {
  ...commonFlags, id: Argument.String("id"), reason: Flag.String("reason"),
}, ({ json, home, id, reason }) =>
  Effect.flatMap(Effect.promise(() => runApprovalDecision({ json, home: Option.getOrUndefined(home), env: process.env, id, decision: "reject", reason })), print),
);

const approval = Command.make("approval").pipe(
  Command.withDescription("Operator decisions about work"),
  Command.withSubcommands([approvalList, approvalShow, approvalAnswer, approvalApprove, approvalReject]),
);

const holdList = Command.make("list", commonFlags, ({ json, home }) =>
  Effect.flatMap(
    Effect.promise(() => runHoldList({ json, home: Option.getOrUndefined(home), env: process.env })),
    print,
  ),
).pipe(Command.withDescription("List the open operator holds"));

const holdShow = Command.make("show", { ...commonFlags, id: Argument.String("id") }, ({ json, home, id }) =>
  Effect.flatMap(
    Effect.promise(() => runHoldShow({ json, home: Option.getOrUndefined(home), env: process.env, id })),
    print,
  ),
).pipe(Command.withDescription("Show one operator hold, its evidence and the commands that apply"));

const hold = Command.make("hold").pipe(
  Command.withDescription("Operator holds: system state waiting on the operator"),
  Command.withSubcommands([holdList, holdShow]),
);

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.optional, Flag.withDescription(description));

const logs = Command.make(
  "logs",
  {
    host: Flag.Boolean("host").pipe(Flag.withDefault(false), Flag.withDescription("Read the Worker Host log")),
    factory: optionalString("factory", "Only lines for this factory ID"),
    ticket: optionalString("ticket", "Only lines for this ticket"),
    slot: optionalString("slot", "Only lines for this slot (station/ordinal)"),
    launch: optionalString("launch", "Only lines for this launch, plus its retained stderr"),
    json: Flag.Boolean("json").pipe(Flag.withDefault(false), Flag.withDescription("Print the API response body")),
    home: optionalString("home", "State root of the instance (default: FOUNDRY_HOME, else ~/.foundry)"),
  },
  (flags) =>
    Effect.gen(function* () {
      const outcome = yield* Effect.promise(() =>
        runLogs({
          host: flags.host,
          json: flags.json,
          factory: Option.getOrUndefined(flags.factory),
          ticket: Option.getOrUndefined(flags.ticket),
          slot: Option.getOrUndefined(flags.slot),
          launch: Option.getOrUndefined(flags.launch),
          home: Option.getOrUndefined(flags.home),
          env: process.env,
        }),
      );

      if (outcome.stdout !== "") {process.stdout.write(outcome.stdout);}

      if (outcome.stderr !== "") {process.stderr.write(outcome.stderr);}

      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Show daemon or Worker Host log lines, filtered by reference; works with the daemon down"));

const ticketFlags = {
  ...commonFlags,
  factory: Flag.String("factory").pipe(
    Flag.optional,
    Flag.withDescription("Factory name; required only when more than one factory is loaded"),
  ),
};

const report = (run: () => Promise<TicketOutcome>) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.promise(run);

    if (outcome.stdout !== "") {process.stdout.write(outcome.stdout);}

    if (outcome.stderr !== "") {process.stderr.write(outcome.stderr);}

    process.exitCode = outcome.exitCode;
  });

const messageSend = Command.make(
  "send",
  {
    ...ticketFlags,
    recipient: Argument.String("room.station"),
    body: Argument.String("text"),
    delivery: Flag.String("delivery").pipe(Flag.optional, Flag.withDescription("after_turn (default) or when_idle")),
  },
  ({ json, home, factory, recipient, body, delivery }) => report(() => runMessageSend({
    json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory),
    recipient, body, delivery: Option.getOrUndefined(delivery), env: process.env,
  })),
).pipe(Command.withDescription("Accept an operator message in the daemon's durable log, without spending budget"));

const message = Command.make("message").pipe(Command.withSubcommands([messageSend]));

const ticketSubmit = Command.make(
  "submit",
  {
    ...ticketFlags,
    file: Argument.String("spec.md"),
    title: Flag.String("title").pipe(Flag.optional, Flag.withDescription("Ticket title (default: first heading)")),
    line: Flag.String("line").pipe(Flag.optional, Flag.withDescription("Production line (default: the factory's)")),
  },
  ({ json, home, factory, file, title, line }) =>
    report(() =>
      runTicketSubmit({
        json,
        home: Option.getOrUndefined(home),
        factory: Option.getOrUndefined(factory),
        file,
        title: Option.getOrUndefined(title),
        line: Option.getOrUndefined(line),
        env: process.env,
      }),
    ),
).pipe(Command.withDescription("Submit a specification as a new ticket in the backlog"));

const ticketList = Command.make("list", ticketFlags, ({ json, home, factory }) =>
  report(() =>
    runTicketList({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), env: process.env }),
  ),
).pipe(Command.withDescription("List tickets"));

const ticketShow = Command.make("show", { ...ticketFlags, number: Argument.Int("n") }, ({ json, home, factory, number }) =>
  report(() =>
    runTicketShow({
      json,
      home: Option.getOrUndefined(home),
      factory: Option.getOrUndefined(factory),
      number,
      env: process.env,
    }),
  ),
).pipe(Command.withDescription("Show one ticket with its transitions and paths"));

const ticketPause = Command.make("pause", { ...ticketFlags, number: Argument.Int("n") }, ({ json, home, factory, number }) =>
  report(() => runTicketPause({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), number, env: process.env })),
).pipe(Command.withDescription("Pause an assigned ticket, preserving its assignment"));

const ticketRetry = Command.make("retry", { ...ticketFlags, number: Argument.Int("n") }, ({ json, home, factory, number }) =>
  report(() => runTicketRetry({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), number, env: process.env })),
).pipe(Command.withDescription("Abandon the assignment and queue a fresh attempt"));

const ticket = Command.make("ticket").pipe(
  Command.withDescription("Submit and inspect tickets"),
  Command.withSubcommands([ticketSubmit, ticketList, ticketShow, ticketPause, ticketRetry]),
);

const factoryList = Command.make("list", commonFlags, ({ json, home }) =>
  Effect.flatMap(
    Effect.promise(() => runFactoryList({ json, home: Option.getOrUndefined(home), env: process.env })),
    print,
  ),
).pipe(Command.withDescription("List the loaded factories and their recorded configuration loads"));

const factoryPath = Command.make("path", { ...commonFlags, name: Argument.String("name") }, ({ json, home, name }) =>
  Effect.flatMap(
    Effect.promise(() => runFactoryPath({ json, home: Option.getOrUndefined(home), env: process.env, name })),
    print,
  ),
).pipe(Command.withDescription("Print the path of a factory's dedicated clone, to add as a Git remote"));

const factorySync = Command.make(
  "sync",
  {
    ...commonFlags,
    name: Argument.String("name"),
    wait: Flag.Boolean("wait").pipe(Flag.withDefault(false), Flag.withDescription("Wait until the sync has finished")),
  },
  ({ json, home, name, wait }) =>
    report(() => runFactorySync({ json, home: Option.getOrUndefined(home), env: process.env, name, wait })),
).pipe(Command.withDescription("Fetch the source's default branch and merge it into the factory's clone"));

const factoryStop = Command.make(
  "stop",
  {
    ...commonFlags,
    name: Argument.String("name"),
    force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Skip the drain and the grace period")),
  },
  ({ json, home, name, force }) =>
    Effect.flatMap(
      Effect.promise(() => runFactoryStop({ json, home: Option.getOrUndefined(home), env: process.env, name, force })),
      print,
    ),
).pipe(Command.withDescription("Stop one factory's workers, leaving the other factories running"));

const factory = Command.make("factory").pipe(
  Command.withDescription("Factories loaded by the daemon and their dedicated clones"),
  Command.withSubcommands([factoryList, factoryPath, factorySync, factoryStop]),
);

const slotList = Command.make("list", ticketFlags, ({ json, home, factory }) =>
  Effect.flatMap(
    Effect.promise(() =>
      runSlotList({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), env: process.env }),
    ),
    print,
  ),
).pipe(Command.withDescription("List the configured slots with their condition and latest launch"));

const slotShow = Command.make(
  "show",
  { ...ticketFlags, slot: Argument.String("station/ordinal") },
  ({ json, home, factory, slot }) =>
    Effect.flatMap(
      Effect.promise(() =>
        runSlotShow({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), slot, env: process.env }),
      ),
      print,
    ),
).pipe(Command.withDescription("Show one slot and its launch history"));

const slotInterrupt = Command.make(
  "interrupt",
  { ...ticketFlags, slot: Argument.String("station/ordinal") },
  ({ json, home, factory, slot }) =>
    Effect.flatMap(
      Effect.promise(() =>
        runSlotInterrupt({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), slot, env: process.env }),
      ),
      print,
    ),
).pipe(Command.withDescription("Abort a slot's current run, keeping its launch and conversation"));

const slotUnfreeze = Command.make(
  "unfreeze",
  { ...ticketFlags, slot: Argument.String("station/ordinal") },
  ({ json, home, factory, slot }) =>
    Effect.flatMap(
      Effect.promise(() =>
        runSlotUnfreeze({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), slot, env: process.env }),
      ),
      print,
    ),
).pipe(Command.withDescription("Unfreeze a slot once the daemon's re-run of its freeze cause check passes"));

const slotReset = Command.make(
  "reset",
  { ...ticketFlags, slot: Argument.String("station/ordinal"), force: Flag.Boolean("force").pipe(Flag.withDefault(false)) },
  ({ json, home, factory, slot, force }) => Effect.flatMap(
    Effect.promise(() => runSlotReset({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), slot, force, env: process.env })),
    print,
  ),
).pipe(Command.withDescription("Discard a frozen or parked slot's conversation and start fresh; --force accepts unconfirmed old groups"));

const slot = Command.make("slot").pipe(
  Command.withDescription("Slots: each station's fixed worker positions and their launches"),
  Command.withSubcommands([slotList, slotShow, slotInterrupt, slotUnfreeze, slotReset]),
);

const shutdown = Command.make(
  "shutdown",
  {
    ...commonFlags,
    force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Skip the drain and the grace period")),
  },
  ({ json, home, force }) =>
    Effect.flatMap(
      Effect.promise(() => runShutdown({ json, home: Option.getOrUndefined(home), env: process.env, force })),
      print,
    ),
).pipe(Command.withDescription("Stop every factory's workers, then the Worker Host, then the daemon"));

const worktreeList = Command.make("list", ticketFlags, ({ json, home, factory }) =>
  report(() => runWorktreeList({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), env: process.env })),
).pipe(Command.withDescription("List retained ticket worktrees"));

const worktreeClean = Command.make("clean", { ...ticketFlags, number: Argument.Int("n"),
  force: Flag.Boolean("force").pipe(Flag.withDefault(false), Flag.withDescription("Discard files and unmerged commits after confirmation; skip before_remove")),
  yes: Flag.Boolean("yes").pipe(Flag.withDefault(false), Flag.withDescription("Confirm the displayed losses without a prompt")),
}, ({ json, home, factory, number, force, yes }) =>
  report(() => runWorktreeClean({ json, home: Option.getOrUndefined(home), factory: Option.getOrUndefined(factory), env: process.env, number, force, yes })),
).pipe(Command.withDescription("Remove an inactive completed or cancelled ticket's worktree and branch"));

const worktree = Command.make("worktree").pipe(Command.withSubcommands([worktreeList, worktreeClean]));

const foundry = Command.make("foundry").pipe(
  Command.withSubcommands([validate, status, shutdown, hold, approval, logs, ticket, events, factory, slot, message, worktree]),
);

Command.run(foundry, { version: "0.0.0" }).pipe(
  // effect/cli has already printed the problem and the help; PRD §11.5 makes a usage error exit 2.
  // A bare help request (ShowHelp with no errors) still exits 0.
  Effect.catchIf(
    (error) => CliError.isCliError(error) && !(Predicate.isTagged(error, "ShowHelp") && error.errors.length === 0),
    () => Effect.sync(() => void (process.exitCode = EXIT_USAGE)),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
