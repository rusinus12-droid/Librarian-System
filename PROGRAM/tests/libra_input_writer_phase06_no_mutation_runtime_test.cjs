'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createLibraVmHarness } = require('./fixtures/libra_vm_harness.cjs');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'plugins', 'LIBRA.js'), 'utf8');
const preflightStart = source.indexOf('const prepareInputWriterEvidence =');
const preflightEnd = source.indexOf('const plannerEvidenceProfile =', preflightStart);
assert.ok(preflightStart >= 0 && preflightEnd > preflightStart, 'Input Writer preflight helper must exist');
const preflightSource = source.slice(preflightStart, preflightEnd);
assert.doesNotMatch(preflightSource, /reconcileCanonicalBranchBeforeRecall\s*\(/,
  'Input Writer must not invoke branch reconciliation that can write manifest/State');
assert.doesNotMatch(preflightSource, /ensureStoryArcForResponse\s*\(/,
  'Input Writer must not invoke the legacy Story Arc migration/write path');
assert.match(preflightSource, /narrative_prompt/,
  'Input Writer reads current Narrative State without using a compatibility migration');
assert.match(preflightSource, /narrative_direction_prompt/,
  'creative Narrative Direction remains separate from current Narrative State');

const chat = { id: 'input-writer-chat', chatId: 'input-writer-chat', message: [], bindedPersona: '' };
for (let turn = 1; turn <= 3; turn += 1) {
  chat.message.push({ role: 'user', data: `user-${turn}`, chatId: `u-${turn}` });
  chat.message.push({ role: 'assistant', data: `assistant-${turn}`, chatId: `a-${turn}` });
}
chat.messages = chat.message;
const character = { id: 'input-writer-character', name: 'Input Writer Fixture', chatPage: 0, chats: [chat] };

(async () => {
  const scriptHandlerKinds = [];
  const harness = await createLibraVmHarness({
    enable_gui: 'false',
    input_writer_enabled: 'true',
    input_writer_mode: 'rp',
  }, {
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return 0; },
    async getCharacter() { return character; },
    async getCharacterFromIndex() { return character; },
    async getChat() { return chat; },
    async getCurrentChat() { return chat; },
    async getChatFromIndex() { return chat; },
    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
      return Array.isArray(fields) ? Object.fromEntries(fields.map(field => [field, all[field] ?? null])) : all;
    },
    async addRisuScriptHandler(kind) { scriptHandlerKinds.push(String(kind)); return true; },
    async runLLMModel() { throw new Error('provider calls are outside this preflight fixture'); }
  });

  try {
    assert.equal(scriptHandlerKinds.includes('input'), false,
      'plugin startup must not register the retired automatic input rewrite hook');

    // First call establishes the fixture scope and one-time migrations. The
    // Phase06 assertion applies to an already-owned live chat, not setup itself.
    await harness.api.prepareInputWriterEvidence('keep the door closed');
    harness.storageWrites.length = 0;
    harness.storageRemovals.length = 0;

    // Advance only the VM clock so a fabricated read timestamp cannot pass
    // because preparation and validation happened in the same millisecond.
    const RealDate = Date;
    let clock = RealDate.parse('2026-09-30T00:00:00Z');
    harness.context.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [clock])); }
      static now() { return clock; }
    };
    const preflight = await harness.api.prepareInputWriterEvidence('keep the door closed');
    assert.equal(preflight.schema, 'libra.input_writer_preflight.v1');
    assert.ok(preflight.deliverySnapshot, 'preflight must seal a delivery snapshot');
    const identity = preflight.deliverySnapshot.identity || preflight.deliverySnapshot;
    assert.ok(String(identity.scopeKey || preflight.scope?.scopeKey || ''), 'snapshot must bind scope');
    assert.ok(String(identity.worldlineId || identity.logicalWorldlineId || ''), 'snapshot must bind active worldline');
    assert.ok(Number.isFinite(Number(identity.revision)), 'snapshot must bind canonical revision');
    assert.ok(String(identity.manifestDigest || identity.artifactDigest || ''), 'snapshot must bind canonical manifest/artifact digest');
    assert.ok(String(preflight.deliverySnapshot.authorityDigest || identity.authorityDigest || ''), 'snapshot must bind authority digest');

    await harness.api.debugBuildInputWriterPrompts(preflight);
    clock += 60000;
    const fresh = await harness.api.debugValidateInputWriterDeliverySnapshot(preflight.deliverySnapshot);
    assert.equal(fresh.ok, true, 'the sealed snapshot must validate while the visible transcript and authority are unchanged');
    assert.equal(fresh.current, true);
    assert.equal(fresh.stale, false);
    const repeated = await harness.api.prepareInputWriterEvidence('keep the door closed');
    assert.deepEqual(repeated.deliverySnapshot.stateAuthority, preflight.deliverySnapshot.stateAuthority,
      'reading the same Micro genesis projection later must return the same State identity');

    // Older valid Heads may lack updatedAt. A read must preserve that absence,
    // while a real persisted timestamp change must still invalidate a candidate.
    const headKey = `libra:v1:scope:${identity.scopeKey}:continuity-state`;
    const legacyHead = structuredClone(preflight.deliverySnapshot.stateAuthority.head);
    delete legacyHead.updatedAt;
    delete legacyHead.microProjection;
    delete legacyHead.responseAuthority;
    const legacyBytes = JSON.stringify(legacyHead);
    harness.values.set(headKey, legacyBytes);
    const legacy = await harness.api.prepareInputWriterEvidence('keep the door closed');
    clock += 60000;
    assert.equal((await harness.api.debugValidateInputWriterDeliverySnapshot(legacy.deliverySnapshot)).ok, true,
      'an unchanged stored Head without a timestamp stays current as time advances');
    assert.equal(harness.values.get(headKey), legacyBytes, 'legacy timestamp normalization must not rewrite storage');

    legacyHead.updatedAt = new RealDate(clock).toISOString();
    harness.values.set(headKey, JSON.stringify(legacyHead));
    assert.equal((await harness.api.debugValidateInputWriterDeliverySnapshot(legacy.deliverySnapshot)).ok, false,
      'an actual stored timestamp update must still change the State identity');
    const persisted = await harness.api.prepareInputWriterEvidence('keep the door closed');
    clock += 60000;
    assert.equal((await harness.api.debugValidateInputWriterDeliverySnapshot(persisted.deliverySnapshot)).ok, true,
      'a real stored timestamp remains stable across reads');
    legacyHead.updatedAt = new RealDate(clock).toISOString();
    harness.values.set(headKey, JSON.stringify(legacyHead));
    assert.equal((await harness.api.debugValidateInputWriterDeliverySnapshot(persisted.deliverySnapshot)).ok, false,
      'stored timestamps must not be removed from the delivery authority hash');
    const beforeTranscriptChange = await harness.api.prepareInputWriterEvidence('keep the door closed');

    // A newly completed visible pair changes the delivery authority even when
    // Canonical/State have not caught up yet. Validation must fail closed before
    // an automatic insert/send can act, while preserving durable stores.
    chat.message.push({ role: 'user', data: 'user-after-candidate', chatId: 'u-after-candidate' });
    chat.message.push({ role: 'assistant', data: 'assistant-after-candidate', chatId: 'a-after-candidate' });
    const stale = await harness.api.debugValidateInputWriterDeliverySnapshot(beforeTranscriptChange.deliverySnapshot);
    assert.equal(stale.ok, false);
    assert.equal(stale.current, false);
    assert.equal(stale.stale, true, 'a candidate generated before the newly completed pair must be stale');
    assert.match(String(stale.reason || ''), /authority_changed|stale|transcript|history/i);

    assert.deepEqual(harness.storageWrites, [],
      'Input Writer preflight, prompt compilation, and fresh/stale validation must not write Canonical/State/Registry or any other durable key');
    assert.deepEqual(harness.storageRemovals, [],
      'Input Writer preflight, prompt compilation, and fresh/stale validation must not remove durable data');
  } finally {
    await harness.cleanup();
  }

  process.stdout.write('libra_input_writer_phase06_no_mutation_runtime_test: PASS\n');
})().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
