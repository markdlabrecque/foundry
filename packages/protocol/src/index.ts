/** Channel frames defined once in Schema, shared by the daemon and the Foundry Pi extension. */
export const packageName = "@foundry/protocol" as const;

export * from "./channel.js";

export * from "./tool-set.js";

export * from "./launch-env.js";
