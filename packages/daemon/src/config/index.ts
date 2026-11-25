/** Factory configuration: the offline, read-only checks shared by `foundry validate` and daemon start. */
export { decodeFactoryYaml, locateProblems } from "./decode.js";
export type { ConfigProblem, DecodeResult } from "./decode.js";
export { FactoryConfig, SUPPORTED_VERSION } from "./schema.js";
export { resolveStations } from "./resolve.js";
export type {
  EffectiveExtension,
  EffectiveStation,
  ResolveOptions,
  ResolveResult,
} from "./resolve.js";
export { checkToolNames, toolSetOf } from "./tool-set.js";
export type { ToolSetEntry, ToolSource } from "./tool-set.js";
