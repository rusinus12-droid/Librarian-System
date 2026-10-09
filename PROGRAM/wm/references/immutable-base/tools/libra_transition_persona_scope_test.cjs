'use strict';
const fs = require('node:fs'), path = require('node:path');
const { load } = require('./libra_management_storage_verified_test.cjs');
const { loadGui } = require('./libra_management_gui_integration_test.cjs');
const checks = [], record = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
const jsonRecords = store => [...store.values()].map(raw => { try { return JSON.parse(raw); } catch (_) { return null; } }).filter(Boolean);
async function seedStore() {
  const seed = await load({ artifact: true, extraExports: 'IntegrityMetaManager,EntityManager,getChatRuntimeScopeKey' });
  const store = new Map(), char = { id: 'fixture-char', chatPage: 0 };
  for (const [persona, names] of [['persona-a', ['Mira Archivist', 'A']], ['persona-b', ['Nolan Vale']]]) {
    const chat = { id: 'fixture-chat', bindedPersona: persona }, scopeKey = seed.api.getChatRuntimeScopeKey(chat, char);
    const entries = names.map(name => {
      const entity = { id: name, name, background: { occupation: name + ' occupation' }, meta: { created: 1, updated: 1 } };
      seed.api.IntegrityMetaManager.applyIntegrityMeta(entity, { domain: 'entity', recordId: name, scopeKey, turn: 1 });
      return { key: name, comment: 'lmai_entity', content: JSON.stringify(entity) };
    });
    if (persona === 'persona-a') {
      const relation = { id: seed.api.EntityManager.makeRelationId('Mira Archivist', 'A', entries), entityA: 'Mira Archivist', entityB: 'A', type: 'trust', meta: { created: 1, updated: 1 } };
      seed.api.IntegrityMetaManager.applyIntegrityMeta(relation, { domain: 'relation', recordId: relation.id, scopeKey, turn: 1 });
      entries.push({ key: 'inherited-trust', comment: 'lmai_relation', content: JSON.stringify(relation) });
      entries.push({ key: 'source-wal', comment: 'lmai_turn_records', content: JSON.stringify({ scopeKey, chatId: chat.id, marker: 'SOURCE_PERSONA_WAL_SENTINEL', records: [] }) });
    }
    const canonical = `char:fixture-char|chat:fixture-chat|persona:${persona}`;
    store.set(seed.api.LibraDataStorage.storageKeyFor(canonical), JSON.stringify({ scopeKey: canonical, entries }));
  }
  return store;
}
async function main() {
  const f = await loadGui({ nativeInitialization: true, store: await seedStore() });
  try {
    const a = f.api, source = f.control.chat, sourceKey = a.LibraDataStorage.storageKeyFor(a.LibraDataStorage.scopeKeyFor(f.control.char, source));
    const otherKey = a.LibraDataStorage.storageKeyFor('char:fixture-char|chat:fixture-chat|persona:persona-b');
    const sourceRaw = f.store.get(sourceKey), otherRaw = f.store.get(otherKey);
    f.control.selectedPersona = 1;
    const transitioned = await a.TransitionManager.executeTransition(), dest = f.control.chat;
    const scope = a.LibraDataStorage.scopeKeyFor(f.control.char, dest), runtimeScope = a.getChatRuntimeScopeKey(dest, f.control.char);
    const admission = await a.LibraDataStorage.preparePersonaContext(f.control.char, dest);
    const readback = await a.LibraDataStorage.readVerified(scope), entries = readback.entries || [];
    const entities = entries.filter(e => e.comment === 'lmai_entity').map(e => JSON.parse(e.content));
    const relations = entries.filter(e => e.comment === 'lmai_relation').map(e => JSON.parse(e.content));
    record('real_persona_transition_is_admitted_in_destination', transitioned && dest.id !== source.id && dest.bindedPersona === 'persona-a' && admission.ok,
      { transitioned, persona: dest.bindedPersona, scope, admission: { ok: admission.ok, reason: admission.reason } });
    record('destination_retains_signed_inherited_entities_and_relations', entities.some(e => e.name === 'Mira Archivist' && e.background?.occupation === 'Mira Archivist occupation') && relations.some(r => [r.entityA, r.entityB].includes('Mira Archivist')),
      { entityNames: entities.map(e => e.name), relationIds: relations.map(r => r.id) });
    record('destination_entity_relation_integrity_uses_target_scope', entities.length >= 2 && relations.length > 0 && [...entities, ...relations].every(e => e.meta?.integrity?.scopeKey === runtimeScope),
      { runtimeScope, entities: entities.map(e => ({ name: e.name, scope: e.meta?.integrity?.scopeKey })), relations: relations.map(r => ({ id: r.id, scope: r.meta?.integrity?.scopeKey })) });
    record('destination_does_not_inherit_other_persona_or_source_wal', !JSON.stringify(entries).includes('Nolan Vale') && !JSON.stringify(entries).includes('SOURCE_PERSONA_WAL_SENTINEL'));
    const ai = 'Mira Archivist records the inherited observatory clue and confirms a new canonical observation.';
    let receipt;
    if (admission.ok) {
      await f.callbacks.beforeRequest([{ role: 'user', content: 'Continue the observatory investigation.' }], 'model');
      f.control.chat.message = [{ role: 'user', data: 'Continue the observatory investigation.', chatId: 'transition-u-1' }, { role: 'assistant', data: ai, chatId: 'transition-a-1' }];
      f.control.chat.msgs = f.control.chat.message;
      await f.callbacks.afterRequest(ai, 'model');
      const deadline = Date.now() + 15000;
      do {
        receipt = jsonRecords(f.store).find(r => r.kind === 'libra_raw_turn' && r.chatId === dest.id && r.status === 'committed');
        if (receipt) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
    }
    const continued = await a.LibraDataStorage.readVerified(scope);
    record('registered_destination_continuation_has_owned_committed_receipt', !!receipt && receipt.scopeKey.endsWith('::persona:persona-a') && receipt.runtimeScopeKey === runtimeScope,
      receipt ? { scope: receipt.scopeKey, runtimeScope: receipt.runtimeScopeKey, chatId: receipt.chatId, status: receipt.status } : { reason: admission.reason || 'receipt_missing' });
    record('registered_destination_continuation_persists_fresh_memory', (continued.entries || []).some(e => e.comment === 'lmai_memory' && e.content.includes('transition-a-1') && e.content.includes(ai)));
    record('source_and_other_persona_raw_are_unchanged', f.store.get(sourceKey) === sourceRaw && f.store.get(otherKey) === otherRaw);
    const fresh = await loadGui({ nativeInitialization: true, store: f.store, character: f.control.char });
    try {
      const freshAdmission = await fresh.api.LibraDataStorage.preparePersonaContext(fresh.control.char, fresh.control.chat);
      const text = JSON.stringify(fresh.api.MemoryEngine.getLorebook(fresh.control.char, fresh.control.chat));
      record('reboot_reads_admitted_destination_entities_and_continuation', freshAdmission.ok && fresh.control.chat.id === dest.id && text.includes('Mira Archivist occupation') && text.includes('transition-a-1') && !text.includes('Nolan Vale') && !text.includes('SOURCE_PERSONA_WAL_SENTINEL'),
        { chatId: fresh.control.chat.id, admission: { ok: freshAdmission.ok, reason: freshAdmission.reason } });
      record('reboot_keeps_source_and_other_persona_raw_unchanged', f.store.get(sourceKey) === sourceRaw && f.store.get(otherKey) === otherRaw);
    } finally { fresh.close(); }
    // Invalid writer targets must fail before touching lore or live caches.
    await a.LibraDataStorage.preparePersonaContext(f.control.char, f.control.chat);
    for (const [label, targetChar, targetChat] of [
      ['unavailable', undefined, undefined],
      ['empty', {}, {}],
      ['character_mismatch', { ...f.control.char, id: 'other-character' }, f.control.chat],
      ['chat_mismatch', f.control.char, f.control.chat],
      ['persona_mismatch', f.control.char, f.control.chat]
    ]) {
      a.EntityManager.rebuildCache(continued.entries, { scopeKey: runtimeScope });
      const lore = JSON.parse(JSON.stringify(continued.entries)), beforeLore = JSON.stringify(lore);
      const beforeCache = JSON.stringify([...a.EntityManager.getEntityCache(), ...a.EntityManager.getRelationCache()]);
      const originalId = f.control.chat.id, originalPersona = f.control.chat.bindedPersona;
      if (label === 'chat_mismatch') f.control.chat.id = 'other-chat';
      if (label === 'persona_mismatch') f.control.chat.bindedPersona = 'persona-b';
      let rejected = false;
      try { await a.EntityManager.saveToLorebook(targetChar, targetChat, lore); } catch (error) { rejected = error.message === 'entity_persistence_target_unverified'; }
      finally { f.control.chat.id = originalId; f.control.chat.bindedPersona = originalPersona; }
      record('entity_writer_rejects_' + label + '_without_mutation', rejected && JSON.stringify(lore) === beforeLore
        && JSON.stringify([...a.EntityManager.getEntityCache(), ...a.EntityManager.getRelationCache()]) === beforeCache);
    }
  } finally { f.close(); }
}
main().catch(error => record('test_completed_without_runtime_error', false, error.stack)).finally(() => {
  const report = { ok: checks.every(c => c.ok), checks };
  fs.mkdirSync(path.join(__dirname, '../test-output'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../test-output/libra-transition-persona-scope-test.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
});
