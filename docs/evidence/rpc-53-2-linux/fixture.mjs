// Disposable FOU-97 integration fixture; loaded explicitly, never installed globally.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
const record = (kind, data) => appendFileSync(join(process.env.PROBE_MARKER_DIR, 'events.jsonl'), JSON.stringify({ slot: process.env.FOUNDRY_SLOT ?? 'ordinary', kind, ...data }) + '\n');
export default function (pi) {
  const faux = fauxProvider({ provider: 'probe-faux', api: 'probe-faux', models: [{ id: 'scripted', name: 'Disposable FOU-97', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] });
  let calls = 0;
  const respond = (context) => {
    faux.appendResponses([respond]);
    record('model-request', { model: 'probe-faux/scripted', context });
    calls++;
    return calls === 1 && process.env.FOUNDRY_SLOT
      ? fauxAssistantMessage(fauxToolCall('probe_named', { value: 'CALL_MARKER_53A' }, { id: 'probe-call-1' }), { stopReason: 'toolUse' })
      : fauxAssistantMessage(fauxText('PROBE_DONE_53A'));
  };
  faux.setResponses([respond]);
  pi.registerProvider(faux.provider);
  for (const name of ['probe_named', 'probe_unnamed']) pi.registerTool({ name, label: name, description: `Configured ${name}`, parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, async execute(id, args) { record('tool-executed', { name, id, args }); return { content: [{ type: 'text', text: 'TOOL_RESULT_53A:' + args.value }], details: {} }; } });
  record('configured-loaded', {});
  pi.on('session_start', (_event, ctx) => {
    record('session', { model: ctx.model, active: pi.getActiveTools(), all: pi.getAllTools(), systemPrompt: ctx.getSystemPrompt() });
    if (process.env.FOUNDRY_SLOT) setTimeout(() => pi.sendUserMessage('Perform the disposable named tool probe.'), 1000);
  });
  pi.on('before_agent_start', (event) => { record('before-agent', { systemPrompt: event.systemPrompt }); });
}
