#!/usr/bin/env node
/**
 * The `foundry` entry point. This is the only Foundry module that imports
 * `effect/cli` (PRD §3.1: unstable Effect modules sit behind one module).
 */
import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { EXIT_USAGE, runStatus } from "./status.js";
import { validateFactoryFile } from "./validate.js";
import { runTicketList, runTicketShow, runTicketSubmit, type TicketOutcome } from "./tickets.js";
import { runHoldList, runHoldShow, type HoldOutcome } from "./holds.js";

const validate = Command.make(
  "validate",
  { file: Argument.String("factory.yaml") },
  ({ file }) =>
    Effect.gen(function* () {
      const outcome = validateFactoryFile(file);
      for (const line of outcome.stdout) yield* Console.log(line);
      for (const line of outcome.stderr) yield* Console.error(line);
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
      if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
      if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Show the running instance's status from the daemon"));

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
    if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
    if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
    process.exitCode = outcome.exitCode;
  });

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
    if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
    if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
    process.exitCode = outcome.exitCode;
  });

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

const ticket = Command.make("ticket").pipe(
  Command.withDescription("Submit and inspect tickets"),
  Command.withSubcommands([ticketSubmit, ticketList, ticketShow]),
);

const foundry = Command.make("foundry").pipe(Command.withSubcommands([validate, status, hold, ticket]));

Command.run(foundry, { version: "0.0.0" }).pipe(
  // effect/cli has already printed the problem and the help; PRD §11.5 makes a usage error exit 2.
  // A bare help request (ShowHelp with no errors) still exits 0.
  Effect.catchIf(
    (error) => CliError.isCliError(error) && !(error._tag === "ShowHelp" && error.errors.length === 0),
    () => Effect.sync(() => void (process.exitCode = EXIT_USAGE)),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
