// Journey: a real pinned `pi` process with the credential-free faux provider
// calls a named fixture tool. Proves the wiring only; script logic is unit-tested.
import { afterEach, expect, test } from "vitest";
import { FIXTURE_TOOL, startFauxPi } from "@foundry/testkit";
import type { FauxPi } from "@foundry/testkit";
import { Schema } from "effect";

const decodeToolEnd = Schema.decodeUnknownSync(
  Schema.Struct({
    toolName: Schema.String,
    isError: Schema.Boolean,
    result: Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })) }),
  }),
);

let pi: FauxPi | undefined;

afterEach(async () => {
  await pi?.dispose();
  pi = undefined;
});

test("faux-provider Pi calls the named fixture tool without credentials or network", async () => {
  pi = startFauxPi();
  const settled = pi.waitFor((e) => e.type === "agent_settled");
  pi.send({ id: "p1", type: "prompt", message: `@@ ${FIXTURE_TOOL} {"text":"marker-42"}` });
  await settled;

  const accepted = pi.events.find((e) => e.type === "response" && e.id === "p1");
  expect(accepted?.success).toBe(true);

  const endEvent = pi.events.find((e) => e.type === "tool_execution_end");
  const end = endEvent === undefined ? undefined : decodeToolEnd(endEvent);

  expect(end?.toolName).toBe(FIXTURE_TOOL);
  expect(end?.isError).toBe(false);
  expect(end?.result.content[0]?.text).toBe("marker-42");
});
