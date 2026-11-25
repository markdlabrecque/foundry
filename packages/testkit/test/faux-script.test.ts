import { expect, test } from "vitest";
import { FAUX_FINAL_TEXT, nextFauxReply, parseFauxScript } from "@foundry/testkit";

test("parses @@ lines into ordered tool steps and ignores other text", () => {
  expect(parseFauxScript('hello\n@@ fixture_echo {"text":"a"}\n  @@ other\nbye')).toEqual([
    { tool: "fixture_echo", arguments: { text: "a" } },
    { tool: "other", arguments: {} },
  ]);
});

test("rejects arguments that are not a JSON object", () => {
  expect(() => parseFauxScript("@@ t {bad")).toThrow(/not valid JSON/);
  expect(() => parseFauxScript("@@ t [1]")).toThrow(/must be a JSON object/);
});

test("replies with the next unanswered step, then the final text", () => {
  const user = { role: "user", content: [{ type: "text", text: '@@ a {}\n@@ b {"x":1}' }] };
  expect(nextFauxReply([user])).toEqual({ kind: "tool", step: { tool: "a", arguments: {} } });
  const afterOne = [user, { role: "assistant" }, { role: "toolResult" }];
  expect(nextFauxReply(afterOne)).toEqual({ kind: "tool", step: { tool: "b", arguments: { x: 1 } } });
  const afterTwo = [...afterOne, { role: "assistant" }, { role: "toolResult" }];
  expect(nextFauxReply(afterTwo)).toEqual({ kind: "text", text: FAUX_FINAL_TEXT });
});

test("reads only the latest user message", () => {
  const old = { role: "user", content: "@@ a {}" };
  expect(nextFauxReply([old, { role: "assistant" }, { role: "user", content: "plain" }])).toEqual({
    kind: "text",
    text: FAUX_FINAL_TEXT,
  });
});
