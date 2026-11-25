import { Effect, Schema } from "effect";

/**
 * The structural shape of factory YAML version 1 (PRD §4), with its defaults.
 *
 * This schema checks keys, types, the version and scalar constraints only. Name
 * grammar, references between lines and stations, configured files, paths and
 * model placeholders are checked by later stages on the decoded value.
 */

const Text = Schema.NonEmptyString;
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** An argument list, run with no implicit shell. Emptiness is checked with commands. */
const Command = Schema.Array(Schema.String);

const withDefault = Schema.withDecodingDefaultKey;

/** A configured extension: a path (hooks only) or a path with the tools it names. */
const ExtensionEntry = Schema.Union([
  Text,
  Schema.Struct({
    path: Text,
    tools: Schema.Array(Text),
  }),
]);

const Station = Schema.Struct({
  instructions: Schema.optionalKey(Text),
  model: Schema.optionalKey(Text),
  skills: Schema.optionalKey(Schema.Array(Text)),
  extensions: Schema.optionalKey(Schema.Array(ExtensionEntry)),
  instances: Schema.optionalKey(PositiveInt).pipe(withDefault(Effect.succeed(1))),
  isolation: Schema.optionalKey(Schema.Literals(["none", "worktree"])).pipe(
    withDefault(Effect.succeed("none" as const)),
  ),
});

const Room = Schema.Struct({
  instructions: Schema.optionalKey(Text),
  stations: Schema.Record(Schema.String, Station),
});

const Stage = Schema.Struct({
  id: Text,
  station: Text,
  writing: Schema.optionalKey(Schema.Boolean).pipe(withDefault(Effect.succeed(false))),
  approval: Schema.optionalKey(Schema.Boolean).pipe(withDefault(Effect.succeed(false))),
  on_rejection: Schema.optionalKey(Text),
});

const ProductionLine = Schema.Struct({
  rejection_limit: Schema.optionalKey(PositiveInt).pipe(withDefault(Effect.succeed(3))),
  verify: Schema.optionalKey(Command),
  stages: Schema.Array(Stage).check(
    Schema.isMinLength(1, { message: "Expected at least one stage" }),
  ),
});

const Worktrees = Schema.Struct({
  root: Schema.optionalKey(Text).pipe(withDefault(Effect.succeed("~/worktrees"))),
  branch_pattern: Schema.optionalKey(Text).pipe(
    withDefault(Effect.succeed("ticket/{ticket-id}-{slug}")),
  ),
  after_create: Schema.optionalKey(Command),
  before_remove: Schema.optionalKey(Command),
});

const Knowledge = Schema.Struct({
  root: Schema.optionalKey(Text).pipe(withDefault(Effect.succeed("knowledge"))),
});

const Defaults = Schema.Struct({
  instructions: Schema.optionalKey(Text),
  model: Schema.optionalKey(Text),
  skills: Schema.optionalKey(Schema.Array(Text)),
  extensions: Schema.optionalKey(Schema.Array(ExtensionEntry)),
});

/** The only factory YAML version this Foundry reads. */
export const SUPPORTED_VERSION = 1;

export const FactoryConfig = Schema.Struct({
  version: Schema.Literal(SUPPORTED_VERSION).annotate({
    message: `Unsupported version; this Foundry supports version ${SUPPORTED_VERSION}`,
  }),
  name: Text,
  repository: Schema.Struct({
    source: Text,
    default_branch: Text,
  }),
  default_production_line: Text,
  worktrees: Schema.optionalKey(Worktrees).pipe(withDefault(Effect.succeed({}))),
  knowledge: Schema.optionalKey(Knowledge).pipe(withDefault(Effect.succeed({}))),
  message_budget: Schema.optionalKey(PositiveInt).pipe(withDefault(Effect.succeed(100))),
  delegation_depth_limit: Schema.optionalKey(NonNegativeInt).pipe(withDefault(Effect.succeed(2))),
  recovery_limit: Schema.optionalKey(PositiveInt).pipe(withDefault(Effect.succeed(3))),
  defaults: Schema.optionalKey(Defaults),
  rooms: Schema.Record(Schema.String, Room),
  production_lines: Schema.Record(Schema.String, ProductionLine),
});

/** A structurally valid factory configuration with its defaults applied. */
export type FactoryConfig = typeof FactoryConfig.Type;
