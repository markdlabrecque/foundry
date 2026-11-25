#!/usr/bin/env node
/**
 * The `foundry` entry point. This is the only Foundry module that imports
 * `effect/cli` (PRD §3.1: unstable Effect modules sit behind one module).
 */
import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { EXIT_USAGE, runStatus } from "./status.js";
import { runLogs } from "./logs.js";
import { validateFactoryFile } from "./validate.js";
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
      if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
      if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
      process.exitCode = outcome.exitCode;
    }),
).pipe(Command.withDescription("Show daemon or Worker Host log lines, filtered by reference; works with the daemon down"));

const foundry = Command.make("foundry").pipe(Command.withSubcommands([validate, status, hold, logs]));

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
