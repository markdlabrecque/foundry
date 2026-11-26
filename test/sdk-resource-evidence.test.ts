// Unit tier: pure evidence classification; no worker, filesystem, timing or network.
import { expect, test } from "vitest";
import { FIXED_TOOLS } from "@foundry/protocol";
import { summarize } from "../docs/evidence/sdk-53-2-linux/summarize.mjs";

const context = (skill: boolean) => ({
  systemPrompt: skill ? "CONFIGURED_SKILL_53A" : "",
  messages: [{ role: "system", toolsAdded: [...FIXED_TOOLS, "probe_named"].map((name) => ({ name })) }],
});

const worker = (slot: string) => [
  { slot, kind: "configured-loaded" },
  { slot, kind: "session", model: { provider: "probe-faux", id: "scripted" } },
  { slot, kind: "model-request", context: context(slot === "inherit/1") },
  { slot, kind: "tool-executed", name: "probe_named", args: { value: "CALL_MARKER_53A" } },
  { slot, kind: "model-request", context: { messages: [
    { role: "assistant", content: [{ type: "toolCall", name: "probe_named", arguments: { value: "CALL_MARKER_53A" } }] },
    { role: "toolResult", content: [{ type: "text", text: "TOOL_RESULT_53A:CALL_MARKER_53A" }] },
  ] } },
];

const supportedRecord = () => {
  const events = [
    { slot: "ordinary", kind: "session", active: ["grep"], all: [{ name: "probe_named" }, { name: "probe_unnamed" }] },
    { slot: "ordinary", kind: "model-request", context: "GLOBAL_CONTEXT_53A GLOBAL_SYSTEM_53A GLOBAL_APPEND_53A mcp__probe__ambient" },
    ...worker("inherit/1"), ...worker("skillclear/1"),
  ];

  const slots = ["inherit/1", "skillclear/1", "clear/1"];

  return {
    root: "/fixture",
    environment: { FOUNDRY_WORKER_RUNTIME: "sdk", PI_OFFLINE: "1" },
    fixture: { fakeAuth: true, clearUnprompted: true, denyFetch: true },
    phase: "observations-complete",
    daemonLog: slots.map((slotId) => ({ msg: "channel accepted", slotId, launchId: slotId, detail: { tools: slotId === "clear/1" ? 12 : 13 } })),
    markers: {
      "events.jsonl": events.map((e) => JSON.stringify(e)).join("\n"),
      "controls.jsonl": JSON.stringify({ marker: "GLOBAL_EXTENSION_53A", slot: "ordinary" }),
      "mcp-starts.jsonl": JSON.stringify({ slot: "ordinary" }),
      "network.jsonl": slots.map((slot) => JSON.stringify({ kind: "deny-fetch-installed", slot })).join("\n"),
      ...Object.fromEntries(slots.map((slot) => [`${slot.replace("/", "_")}.launch.fixture.json`, JSON.stringify({
        cwd: "/fixture/state/slots/" + slot.replace("/", "-"),
        argv: ["/checkout/packages/host/dist/sdk-worker.js", "--model", slot === "clear/1" ? "openai/gpt-4.1-mini" : "probe-faux/scripted", "--tools", [...FIXED_TOOLS, ...(slot === "clear/1" ? [] : ["probe_named"])].join(",")],
      })])),
    },
    ownedBeforeShutdown: [{ slot: "inherit/1", pid: 42, pgid: 42 }],
    ownedAfterShutdown: [],
    remainingOwnedGroupMembers: [],
  };
};

test("empty or exit-zero-only records never verify negative exclusions or invent a model failure", () => {
  for (const record of [{}, { outcome: "supported", phase: "ordinary-calibration", markers: {} }]) {
    const result = summarize(record);
    expect(result.outcome).toBe("inconclusive");
    expect(Object.values(result.observations).every((o) => o.status === "unverified")).toBe(true);
    expect(result.reason).not.toContain("model is not registered");
  }
});

test("calibration failure makes absence in otherwise populated worker records unverified", () => {
  const record = supportedRecord();
  record.markers["controls.jsonl"] = "";
  const result = summarize(record);
  expect(result.outcome).toBe("inconclusive");
  expect(result.observations["ordinary global controls"]?.status).toBe("unverified");
  expect(result.observations["global/repository extensions and MCP excluded in connected workers"]?.status).toBe("unverified");
  expect(result.observations["fully cleared inheritance in a connected unprompted station"]?.status).toBe("unverified");
});

test.each(["hello", "model-request"])("calibrated controls missing %s evidence cannot certify exclusion", (missing) => {
  const record = supportedRecord();

  if (missing === "hello") {record.daemonLog = [];}
  else {record.markers["events.jsonl"] = record.markers["events.jsonl"].split("\n").slice(0, 2).join("\n");}

  const result = summarize(record);
  expect(result.observations["ordinary global controls"]?.status).toBe("verified");
  expect(result.observations["global/repository extensions and MCP excluded in connected workers"]?.status).toBe("unverified");
  expect(result.outcome).toBe("inconclusive");
});

test("complete observations support qualification independently of the driver's outcome label", () => {
  const result = summarize({ ...supportedRecord(), outcome: "inconclusive" });
  expect(result.outcome).toBe("supported");
  expect(Object.values(result.observations).every((o) => o.status === "verified")).toBe(true);
});

test("an actual clear launch error supplies the reason without requiring three retries", () => {
  const record = supportedRecord();
  record.daemonLog = record.daemonLog.filter((e) => e.slotId !== "clear/1");
  const failure = "Error: SDK model is not registered: disposable/example";
  const result = summarize({ ...record, phase: "worker-observations", launchErrors: { "fixture.stderr": failure } });
  expect(result.outcome).toBe("blocked-on-tested-approaches");
  expect(result.reason).toBe(failure);
  expect(result.observations["fully cleared inheritance in a connected unprompted station"]?.status).toBe("unverified");
});
