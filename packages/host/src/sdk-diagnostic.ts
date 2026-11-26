/** Pre-session evidence comes from the loader's retained registrations, never stderr.
 * fd 3 is a bounded, host-created per-child diagnostic pipe; identity is attached by
 * the host, not supplied in this payload. No successful hello/session is invented.
 */
import { Option, Schema } from "effect";
import { REGISTERED_AGENT_TOOLS } from "@foundry/protocol";

const AgentCollision = Schema.Struct({
  name: Schema.Literals(REGISTERED_AGENT_TOOLS),
  sources: Schema.Array(Schema.NonEmptyString),
});

export const StartupDiagnosticSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("agent_tool_collision"),
  collisions: Schema.Array(AgentCollision),
});

export type StartupDiagnostic = typeof StartupDiagnosticSchema.Type;

export const STARTUP_DIAGNOSTIC_BYTES = 65_536;

export const decodeStartupDiagnostic = (text: string): StartupDiagnostic | undefined => {
  if (Buffer.byteLength(text) > STARTUP_DIAGNOSTIC_BYTES) {return undefined;}

  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(StartupDiagnosticSchema))(text);

  if (Option.isNone(decoded)) {return undefined;}

  const diagnostic = decoded.value;

  return diagnostic.collisions.length > 0 && diagnostic.collisions.every((c) => new Set(c.sources).size >= 2)
    ? diagnostic : undefined;
};

/** Pi 1.6.0 keeps all extensions in LoadExtensionsResult on conflict, including
 * each extension's tools map. Use that positive evidence instead of parsing its
 * untyped error strings (which can also originate in extension code).
 */
export const agentToolCollisions = (extensions: ReadonlyArray<{
  readonly path: string;
  readonly tools: ReadonlyMap<string, unknown>;
}>): StartupDiagnostic["collisions"] => REGISTERED_AGENT_TOOLS.flatMap((name) => {
  const sources = [...new Set(extensions.flatMap((e) => e.tools.has(name) ? [e.path] : []))];

  return sources.length < 2 ? [] : [{ name, sources }];
});

