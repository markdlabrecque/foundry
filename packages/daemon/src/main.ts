#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, and hold it until
 * SIGINT or SIGTERM. A clean stop releases the lock and exits 0; a held lock exits 1 (PRD §11.6).
 * Factory loading, the database and the management socket arrive in later tickets.
 */
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { selectStateRoot } from "./state-root.js";

const EXIT_USAGE = 2;
const EXIT_INSTANCE_FAILURE = 1;

const parseHome = (args: readonly string[]): string | undefined => {
  let home: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--home") {
      const value = args[++i];
      if (value === undefined || value === "") throw new UsageError("--home needs a directory");
      home = value;
    } else if (arg.startsWith("--home=")) {
      home = arg.slice("--home=".length);
      if (home === "") throw new UsageError("--home needs a directory");
    }
    // Other arguments (factory files) are left for later tickets.
  }
  return home;
};

class UsageError extends Error {}

const main = (): void => {
  let home: string | undefined;
  try {
    home = parseHome(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`foundry daemon: ${(error as Error).message}\n`);
    process.exit(EXIT_USAGE);
  }
  const stateRoot = selectStateRoot({ home, env: process.env });
  let claim;
  try {
    claim = claimStateRoot(stateRoot);
  } catch (error) {
    if (error instanceof StateRootLockedError) {
      process.stderr.write(`foundry daemon: ${error.message}\n`);
      process.exit(EXIT_INSTANCE_FAILURE);
    }
    throw error;
  }
  process.on("exit", () => claim.release());
  // Keep the foreground process alive until asked to stop.
  const keepAlive = setInterval(() => {}, 1 << 30);
  const stop = (): void => {
    clearInterval(keepAlive);
    claim.release();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`foundry daemon: state root ${stateRoot} claimed (pid ${process.pid})\n`);
};

main();
