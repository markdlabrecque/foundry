// Journey: a real pinned `pi` process with the credential-free faux provider
// calls a named fixture tool. Proves the wiring only; script logic is unit-tested.
import { afterEach, expect, test } from "vitest";
import { FIXTURE_TOOL, startFauxPi } from "@foundry/testkit";
import type { FauxPi } from "@foundry/testkit";

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

  const end = pi.events.find((e) => e.type === "tool_execution_end") as
    | { toolName: string; isError: boolean; result: { content: Array<{ text: string }> } }
    | undefined;

  expect(end?.toolName).toBe(FIXTURE_TOOL);
  expect(end?.isError).toBe(false);
  expect(end?.result.content[0]?.text).toBe("marker-42");
});
