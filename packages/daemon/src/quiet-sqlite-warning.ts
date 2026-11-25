/**
 * Drops Node's one-off "SQLite is an experimental feature" ExperimentalWarning, which loading
 * `node:sqlite` prints to stderr outside the daemon log. Every other warning is emitted unchanged.
 *
 * Imported for its side effect by the daemon entry point before anything that loads the store,
 * since ES modules evaluate their imports in order.
 */
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;

process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type =
    typeof warning !== "string"
      ? warning.name
      : typeof rest[0] === "string"
        ? rest[0]
        : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && /^SQLite is an experimental feature/.test(message)) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

export {};
