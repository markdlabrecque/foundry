// Evidence-only independent checks; no Foundry product imports, IO or signals.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/** A fallback can make the machine safe, never make orderly shutdown pass. All
 * operations are injected so exception/survivor verdicts need no process test. */
export async function verifyCleanup(ops) {
  const result = { orderly: false, errors: [], fallbackUsed: false, rootRemoved: false };
  const attempt = async (label, fn) => {
    try { return await fn(); }
    catch (error) { result.errors.push(`${label}: ${String(error)}`); return undefined; }
  };
  const survivors = snapshot => snapshot.owned.length > 0 || snapshot.groups.some(g => g.members.length > 0);
  await attempt('shutdown', ops.shutdown);
  result.before = await attempt('pre-fallback snapshot', ops.snapshot);
  if (!result.before || survivors(result.before)) {
    result.errors.push('orderly shutdown not verified: pre-fallback survivors or unavailable observation');
    result.fallbackUsed = true;
    await attempt('owned fallback', ops.fallback);
  }
  result.after = await attempt('post-fallback snapshot', ops.snapshot);
  if (!result.after || survivors(result.after)) {
    result.errors.push('cleanup incomplete: post-fallback survivors or unavailable observation');
  } else {
    await attempt('remove disposable root', ops.removeRoot);
    const present = await attempt('verify disposable root absence', ops.rootExists);
    result.rootRemoved = present === false;
    if (!result.rootRemoved) result.errors.push('disposable root absence not verified');
  }
  result.orderly = result.errors.length === 0 && !result.fallbackUsed && result.rootRemoved;
  return result;
}

/** Independent contract oracle, not the product composer. Inputs are ordered
 * source bytes read from the disposable fixture, not from daemon prime output. */
export function assertExpectedPrimes({ injected, records, conversationRef, expected }) {
  const situations = ['fresh', 'recovery', 'compaction'];
  assert.equal(injected.length, 3);
  assert.equal(records.length, 3);
  const parts = expected.sources.map(({ source, content }) => ({ source, hash: 'sha256:' + createHash('sha256').update(content).digest('hex') }));
  for (const [i, situation] of situations.entries()) {
    const prime = injected[i], record = records[i];
    const header = `# Foundry prime\n\nAddress: ${expected.address}\nSlot: ${expected.slotId}\nSituation: ${situation}\n\nConventions:\n- A station with \`isolation: none\` writes only in the ticket directory. This station's isolation is \`${expected.isolation}\`.\n- Workers do not write to the knowledge root (\`${expected.knowledgeRoot}\`).\n\nConfigured instructions follow, factory → room → station. Each part names its source path, relative to the factory YAML's directory, and its content hash.\n`;
    const body = expected.sources.map(({ content }, n) => `\n<foundry-source path="${parts[n].source}" hash="${parts[n].hash}">\n${content.endsWith('\n') ? content : content + '\n'}</foundry-source>\n`).join('');
    assert.equal(prime.type, 'custom_message');
    assert.equal(prime.customType, 'foundry');
    assert.equal(prime.details.kind, 'prime');
    assert.equal(prime.content, header + body, `${situation}: independently expected complete header and ordered source bodies`);
    assert.equal(record.situation, situation);
    assert.equal(record.slot_id, expected.slotId);
    assert.equal(record.conversation_ref, conversationRef);
    assert(record.acknowledged_at !== null && record.acknowledged_at !== undefined);
    assert.deepEqual(JSON.parse(record.parts), parts, `${situation}: ordered source paths and independently hashed fixture bytes`);
    assert.equal(prime.details.foundryId, record.id);
    assert.equal(injected.filter(p => p.details.foundryId === record.id).length, 1);
  }
}
