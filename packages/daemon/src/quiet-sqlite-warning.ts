/**
 * Drops Node's one-off `ExperimentalWarning` for `node:sqlite`, which the store loads. Once the
 * state root is claimed, the daemon's stderr carries only its structured log lines (PRD §15.2).
 * Every other warning still reaches Node's own handlers.
 *
 * Imported first by `main.ts`, before any module that loads SQLite. Node emits warnings on a later
 * tick, so the filter is in place by the time it would be printed.
 */
const isSqliteExperimental = (warning: Error): boolean =>
  warning.name === "ExperimentalWarning" && /\bSQLite\b/i.test(warning.message);

const original = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (isSqliteExperimental(warning)) return;
  for (const listener of original) listener(warning);
});

export {};
