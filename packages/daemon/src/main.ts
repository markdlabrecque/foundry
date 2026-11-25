#!/usr/bin/env node
/**
 * Foreground daemon entry point: select the state root, claim it exclusively, serve the
 * management API, and hold both until SIGINT or SIGTERM. A clean stop closes the socket,
 * releases the lock and exits 0; a held lock or a socket in use exits 1 (PRD §11.6).
 * Factory loading and the database arrive in later tickets.
 */
import { claimStateRoot, StateRootLockedError } from "./instance-lock.js";
import { ManagementSocketError, serveManagementApi, type ManagementApi } from "./management-api.js";
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

const fail = (message: string): never => {
  process.stderr.write(`foundry daemon: ${message}\n`);
  process.exit(EXIT_INSTANCE_FAILURE);
};

const main = async (): Promise<void> => {
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
    // A held lock, or a root we cannot create or write (EACCES and the like), is an instance-level
    // failure: one line and exit 1, not a stack trace.
    fail(error instanceof StateRootLockedError ? error.message : `cannot claim state root ${stateRoot}: ${(error as Error).message}`);
    return;
  }
  process.on("exit", () => claim.release());

  const startedAt = new Date().toISOString();
  let api: ManagementApi;
  try {
    api = await serveManagementApi({
      stateRoot,
      status: () => ({ instance: { stateRoot, daemonPid: process.pid, startedAt } }),
    });
  } catch (error) {
    claim.release();
    fail(error instanceof ManagementSocketError ? error.message : `cannot serve the management API: ${(error as Error).message}`);
    return;
  }

  // The listening socket keeps the foreground process alive until asked to stop.
  const stop = (): void => {
    void api.close().finally(() => {
      claim.release();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdout.write(`foundry daemon: state root ${stateRoot} claimed (pid ${process.pid})\n`);
  process.stdout.write(`foundry daemon: management API on ${api.socketPath}\n`);
};

await main();
