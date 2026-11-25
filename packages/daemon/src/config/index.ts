/** Factory configuration: the offline, read-only checks shared by `foundry validate` and daemon start. */
export { decodeFactoryYaml } from "./decode.js";
export type { ConfigProblem, DecodeResult } from "./decode.js";
export { FactoryConfig, SUPPORTED_VERSION } from "./schema.js";
