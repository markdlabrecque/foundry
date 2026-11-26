// Explicit disposable observer/provider. No replacement of Foundry transport or priming.
import { appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
const record = (kind, data = {}) => appendFileSync(join(process.env.PROBE_DIR, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, launch: process.env.FOUNDRY_LAUNCH_ID, kind, ...data }) + '\n');
export default function(pi) {
  const faux = fauxProvider({ provider: 'restore-probe', api: 'restore-faux', models: [{ id: 'scripted', name: 'Disposable restoration probe', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] });
  let command = '', called = false;
  const respond = (context) => {
    faux.appendResponses([respond]);
    const summary = getCurrentSystemPrompt(context.messages).includes('context summarization assistant');
    record('model-request', { command, summary, context });
    if (summary) return fauxAssistantMessage(fauxText('## Goal\nDisposable restoration and compaction probe.\n## Progress\nFIRST_148 completed once; history is not execution replay.'));
    if (!called && ['FIRST_148', 'RECOVERED_148'].includes(command)) {
      called = true;
      return fauxAssistantMessage(fauxToolCall(command === 'FIRST_148' ? 'probe_once' : 'agent_discover', {}, { id: command + '-call' }), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage(fauxText('DONE_' + command));
  };
  faux.setResponses([respond]); pi.registerProvider(faux.provider);
  pi.registerTool({ name: 'probe_once', label: 'Disposable side effect', description: 'Append exactly one disposable execution marker.', parameters: { type: 'object', properties: {}, additionalProperties: false }, async execute(id) {
    record('side-effect', { id });
    return { content: [{ type: 'text', text: 'ONCE_RESULT_148' }], details: {} };
  } });
  // Foundry delivers custom messages, not Pi user-input events. Observe the
  // actual turn's custom message rather than synthesizing an input event.
  pi.on('before_agent_start', (event) => {
    command = /(?:FIRST|RECOVERED|PAD_A|PAD_B|AFTER_COMPACT)_148/.exec(JSON.stringify(event.message))?.[0] ?? 'unknown';
    called = false; record('command', { command });
  });
  for (const kind of ['before_agent_start', 'agent_start', 'agent_end', 'agent_settled', 'tool_execution_start', 'tool_execution_end', 'session_before_compact', 'session_compact', 'session_compact_failed']) {
    pi.on(kind, (event, ctx) => record(kind, { event, idle: ctx.isIdle(), branch: kind === 'agent_settled' || kind === 'session_compact' ? ctx.sessionManager.getBranch() : undefined }));
  }
  let timer;
  pi.on('session_start', (_event, ctx) => {
    record('session-start', { argv: process.argv, execPath: process.execPath, cwd: process.cwd(), model: ctx.model, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), branch: ctx.sessionManager.getBranch(), systemPrompt: ctx.getSystemPrompt(), tools: pi.getActiveTools() });
    timer = setInterval(() => {
      const request = join(process.env.PROBE_DIR, 'compact-request');
      if (!existsSync(request) || !ctx.isIdle()) return;
      unlinkSync(request); record('compact-request');
      ctx.compact({ onComplete: result => record('compact-complete', { result }), onError: error => record('compact-error', { error: String(error) }) });
    }, 100);
  });
  pi.on('session_shutdown', () => clearInterval(timer));
}
