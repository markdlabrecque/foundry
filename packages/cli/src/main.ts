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
import { runHoldList, runHoldShow, type HoldOutcome } from "./holds.js";
import { runEvents } from "./events.js";

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
          signal,
        }),
      );
      if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
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

const foundry = Command.make("foundry").pipe(Command.withSubcommands([validate, status, hold, events]));

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
