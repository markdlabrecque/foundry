/**
 * Loads the store module without Node's one-off `node:sqlite` ExperimentalWarning. The daemon's
 * stderr carries exactly what it writes to `logs/daemon.log` (PRD §15.2), and a raw Node warning
 * would break that. Every other warning still passes through.
 */
import { Schema } from "effect";

const loadStore = () => import("./store.js");

type Store = Awaited<ReturnType<typeof loadStore>>;

/** `process.emitWarning`'s overloads, seen as one call that forwards its arguments unchanged. */
interface WarningEmitter {
  emitWarning(warning: string | Error, ...rest: Array<unknown>): void;
}

const isText = Schema.is(Schema.String);

/** The options form of `emitWarning`'s second argument. */
const hasWarningType = Schema.is(Schema.Struct({ type: Schema.String }));

const isSqliteExperimental = (warning: string | Error, type: string | undefined): boolean => {
  const message = warning instanceof Error ? warning.message : warning;

  return type === "ExperimentalWarning" && /SQLite/.test(message);
};

export const importStoreQuietly = async (): Promise<Store> => {
  // Restored exactly, so the process keeps its own `emitWarning` once the store is loaded.
  const descriptor = Object.getOwnPropertyDescriptor(process, "emitWarning");
  const original: WarningEmitter = { emitWarning: process.emitWarning.bind(process) };

  process.emitWarning = (warning: string | Error, ...rest: Array<unknown>) => {
    const [second] = rest;
    const type = warning instanceof Error ? warning.name : isText(second) ? second : hasWarningType(second) ? second.type : undefined;

    if (isSqliteExperimental(warning, type)) {return;}

    original.emitWarning(warning, ...rest);
  };

  try {
    return await loadStore();
  } finally {
    if (descriptor !== undefined) {Object.defineProperty(process, "emitWarning", descriptor);}
  }
};
