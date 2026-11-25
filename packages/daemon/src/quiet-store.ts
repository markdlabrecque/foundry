/**
 * Loads the store module without Node's one-off `node:sqlite` ExperimentalWarning. The daemon's
 * stderr carries exactly what it writes to `logs/daemon.log` (PRD §15.2), and a raw Node warning
 * would break that. Every other warning still passes through.
 */
type Store = typeof import("./store.js");

const isSqliteExperimental = (warning: unknown, rest: ReadonlyArray<unknown>): boolean => {
  const message = warning instanceof Error ? warning.message : String(warning);
  const type = warning instanceof Error ? warning.name : typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type;

  return type === "ExperimentalWarning" && /SQLite/.test(message);
};

export const importStoreQuietly = async (): Promise<Store> => {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: Array<unknown>) => {
    if (isSqliteExperimental(warning, rest)) {return;}

    (original as (...args: Array<unknown>) => void).call(process, warning, ...rest);
  });

  try {
    return await import("./store.js");
  } finally {
    process.emitWarning = original;
  }
};
