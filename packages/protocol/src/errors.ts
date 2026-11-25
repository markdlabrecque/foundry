/**
 * Reading a thrown value for display. Anything can be thrown, so a caught value is read through
 * this rather than asserted to be an `Error`.
 */
import { Schema } from "effect";

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }));

/** The message of a thrown value: its `message` when it has one, otherwise its string form. */
export const messageOf = (cause: unknown): string => (hasMessage(cause) ? cause.message : String(cause));

const hasCode = Schema.is(Schema.Struct({ code: Schema.String }));

/** The `code` of a thrown value, such as a Node filesystem error's `ENOENT`, when it has one. */
export const codeOf = (cause: unknown): string | undefined => (hasCode(cause) ? cause.code : undefined);
