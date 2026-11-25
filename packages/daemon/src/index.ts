/** The Foundry daemon: an Effect 4 program and the only process that opens the database. */
export const packageName = "@foundry/daemon" as const;

export * from "./channel/server.js";
export {
  discoverRepositoryContext,
  type RepositoryContext,
  type RepositoryContextFile,
  type SkillHeader,
} from "./repository-context.js";
