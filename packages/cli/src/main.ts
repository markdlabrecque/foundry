#!/usr/bin/env node
/** `foundry` entry point. */
import { runCli } from "./run.js";

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
