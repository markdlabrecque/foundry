#!/usr/bin/env node
/**
 * The `foundry` entry point. This is the only Foundry module that imports
 * `effect/cli` (PRD §3.1: unstable Effect modules sit behind one module).
 */
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { validateFactoryFile } from "./validate.js";

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

const foundry = Command.make("foundry").pipe(Command.withSubcommands([validate]));

Command.run(foundry, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
