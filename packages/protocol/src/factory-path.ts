/**
 * `foundry factory path <name>` over the management API (PRD §9.1, §11.1): the path of the
 * factory's dedicated clone, which the operator adds as an ordinary Git remote.
 */
import { MANAGEMENT_API_PREFIX } from "./management-api.js";

const FACTORIES_PREFIX = `${MANAGEMENT_API_PREFIX}/factories/`;
const PATH_SUFFIX = "/path";

/** `GET`: the clone path of one loaded factory. */
export const factoryPathPath = (factory: string): string =>
  `${FACTORIES_PREFIX}${encodeURIComponent(factory)}${PATH_SUFFIX}`;

/**
 * The factory name a request path asks for: `undefined` when the path is not this route, `null`
 * when it is but the name segment is not valid percent-encoding.
 */
export const matchFactoryPathPath = (path: string): string | null | undefined => {
  if (!path.startsWith(FACTORIES_PREFIX) || !path.endsWith(PATH_SUFFIX)) return undefined;
  const segment = path.slice(FACTORIES_PREFIX.length, path.length - PATH_SUFFIX.length);
  if (segment === "" || segment.includes("/")) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
};

export interface FactoryPathResult {
  readonly factory: string;
  /** Absolute path of the factory's Foundry-owned clone. */
  readonly path: string;
}

export const isFactoryPathResult = (value: unknown): value is FactoryPathResult =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>)["factory"] === "string" &&
  typeof (value as Record<string, unknown>)["path"] === "string";
