/**
 * Pi extension: registers the credential-free scripted model
 * `foundry-faux/scripted`, built on pi-ai's faux provider. It makes no network
 * call and needs no credential. See `../faux-script.ts` for the script rules.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseFactory, ToolCall } from "@earendil-works/pi-ai";
import { nextFauxReply } from "../faux-script.js";

export const FAUX_PROVIDER = "foundry-faux";
export const FAUX_MODEL = "scripted";

export default function fauxProviderExtension(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    api: FAUX_PROVIDER,
    models: [
      { id: FAUX_MODEL, name: "Foundry scripted faux model", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 4096 },
    ],
  });

  let calls = 0;

  // The faux core consumes one queued step per request; each step queues the next.
  const respond: FauxResponseFactory = (context) => {
    faux.appendResponses([respond]);
    const reply = nextFauxReply(context.messages);

    if (reply.kind === "text") {return fauxAssistantMessage(fauxText(reply.text));}

    calls += 1;
    const args: ToolCall["arguments"] = reply.step.arguments;

    return fauxAssistantMessage(fauxToolCall(reply.step.tool, args, { id: `faux-${calls}` }), { stopReason: "toolUse" });
  };

  faux.setResponses([respond]);
  pi.registerProvider(faux.provider);
}
