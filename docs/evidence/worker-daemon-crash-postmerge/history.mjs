// Pi records Foundry messages as custom_message entries as well as ordinary message entries.
export function messageText(message) {
  return typeof message?.content === 'string' ? message.content
    : Array.isArray(message?.content) ? message.content.map((b) => b.text ?? '').join('\n') : '';
}
export function historyBodies(branch) {
  return branch.map((entry) => messageText(entry.message ?? entry));
}
