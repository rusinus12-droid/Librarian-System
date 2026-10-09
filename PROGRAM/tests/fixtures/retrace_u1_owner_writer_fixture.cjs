'use strict';

// A self-contained variant of the U1 shared-host fixture.  It reuses the
// deployed five-plugin public handoff harness and changes only test seams:
// owner seeding, a deterministic LIBRA provider, and owner-side readbacks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const programRoot = path.resolve(__dirname, '..', '..');
const publicHarness = path.join(programRoot, 'tests', 'retrace_u1_public_handoff_test.cjs');

const replaceOnce = (source, needle, replacement, label) => {
  assert.ok(source.includes(needle), `${label}: public fixture seam changed`);
  return source.replace(needle, replacement);
};

const run = ({ scenario = 'different', gui = false } = {}) => {
  assert.ok(['same', 'different'].includes(scenario), `unknown persona scenario: ${scenario}`);
  let source = fs.readFileSync(publicHarness, 'utf8');
  source = replaceOnce(source,
    '  character.chats = chats;\n  const faults = options.faults || {};',
    `  character.chats = chats;
  const libraArtifact = require('./fixtures/libra_unified_runtime_fixture.cjs').artifact();
  const scenario = ${JSON.stringify(scenario)};
  const sourcePersona = { id: 'source-persona', name: 'Source Persona', personaPrompt: 'Source persona prompt', note: '' };
  const otherPersona = { id: 'other-native-persona', name: 'Other Native Persona', personaPrompt: 'Other native prompt', note: '' };
  const db = { personas: [sourcePersona, otherPersona], selectedPersona: scenario === 'same' ? 0 : 1, characters: [character], plugins: [] };
  const faults = options.faults || {};`, 'host setup');
  source = replaceOnce(source,
    `    async getDatabase(fields) {
      const all = { personas: [], selectedPersona: '', characters: [character], plugins: [] };
      if (!Array.isArray(fields)) return all;
      return Object.fromEntries(fields.map(field => [field, all[field] ?? null]));
    },
    async setDatabase() { return true; },`,
    `    async getDatabase(fields) { if (!Array.isArray(fields)) return db; return Object.fromEntries(fields.map(field => [field, db[field] ?? null])); },
    async setDatabase(patch) { Object.assign(db, patch || {}); return true; },`, 'database owner');
  source = replaceOnce(source,
    `    async getChatFromIndex(index) {
      const wanted = Number(index);
      if (Number.isInteger(wanted) && wanted >= 0 && wanted < chats.length) return chats[wanted];
      return chats[0];
    },
    async setCharacterToIndex(index, payload) {`,
    `    async getChatFromIndex(characterIndex, chatIndex) {
      const wanted = Number(chatIndex === undefined ? characterIndex : chatIndex);
      if (Number.isInteger(wanted) && wanted >= 0 && wanted < chats.length) return chats[wanted];
      return chats[0];
    },
    async setChatToIndex(characterIndex, chatIndex, payload) {
      const wanted = Number(chatIndex); if (Number(characterIndex) !== 0 || !Number.isInteger(wanted) || !payload) return false;
      chats[wanted] = payload; host.character.chats = chats; return true;
    },
    async setCharacterToIndex(index, payload) {`, 'chat reader');
  source = replaceOnce(source,
    `  for (const file of PLUGIN_FILES) {
    vm.runInContext(fs.readFileSync(path.join(root, 'plugins', file), 'utf8'), context, { filename: file });
  }`,
    `  for (const file of PLUGIN_FILES) {
    let pluginSource = fs.readFileSync(path.join(root, 'plugins', file), 'utf8');
    if (file === 'LIA_Persona_Linker.js') {
      const marker = '      getLiveSyncCaptureState:';
      if (!pluginSource.includes(marker)) throw new Error('LIA fixture reader seam changed');
      pluginSource = pluginSource.replace(marker, \`      debugAuditConfigure: async choice => configureLivePersonaSync(await getLiveRuntimeContext(), choice),
      debugAuditReadCurrentBinding: async () => readLivePersonaBindingByScopeKey(livePersonaScopeKey(await getLiveRuntimeContext()), true),
      getLiveSyncCaptureState:\`);
    }
    vm.runInContext(pluginSource, context, { filename: file });
  }`, 'plugin loading');
  source = replaceOnce(source,
    '  return { hayaku: hayakuReconcile };\n};',
    `  const liaRuntime = context.__lia_persona_linker_runtime_v1__;
  assert.ok(liaRuntime?.debugAuditConfigure, 'LIA owner writer is exposed only to this fixture');
  const liaSeed = await liaRuntime.debugAuditConfigure('id:source-persona');
  assert.ok(liaSeed?.livePersonaId, 'LIA owner writer creates source Live Persona');
  const flashback = context.__FlashbackMemory;
  const flashbackScope = await flashback.resolveCurrentScope(false);
  const records = Array.from({ length: 8 }, (_, index) => ({ id: 'u1-fb-' + (index + 1), hash: 'u1-fb-' + (index + 1), type: 'response', sourceType: 'response', text: 'U1 Flashback record ' + (index + 1), dim: 4, vector: [1,0,0,0], turnIndex: index + 1, sourceTurn: index + 1, lifecycleStatus: 'active' }));
  await flashback._test.saveAllRecords(records, null, flashbackScope);
  assert.equal((await flashback._test.loadScopeRecords(flashbackScope.scopeKey)).records.length, 8, 'Flashback owner writer readback');
  const libra = context.__LIBRA__;
  await libra.saveLibraMemorySettings({ ...(await libra.getLibraMemorySettings()), memoryEngine: 'unified' });
  const libraSeed = await libra.runManualColdStart();
  assert.equal(libraSeed?.completed, 1, 'controlled LIBRA owner writer commits canonical memory');
  const stableRows = rows => (rows || []).map(row => ({
    id: String(row?.id || row?.recordId || row?.memoryId || row?.key || ''),
    hash: String(row?.hash || row?.sourceDigest || row?.digest || ''),
    text: String(row?.text || row?.data || row?.raw || row?.summary || row?.canonicalText || '')
  })).sort((left, right) => (left.id + left.hash).localeCompare(right.id + right.hash));
  const sourceHayaku = await context.HAYAKU.ledger.inspect({ includeRecords: true });
  const sourceLibra = await libra.getCanonicalMemories();
  const sourceLia = await liaRuntime.debugAuditReadCurrentBinding();
  const sourceOwnerReads = {
    flashback: { scopeKey: flashbackScope.scopeKey, records: records.length, rows: stableRows((await flashback._test.loadScopeRecords(flashbackScope.scopeKey)).records) },
    hayaku: { scopeKey: sourceHayaku.scopeKey, records: sourceHayaku.recordCount, rows: stableRows(sourceHayaku.records) },
    libra: { records: sourceLibra.length, rows: stableRows(sourceLibra) },
    lia: { scopeKey: sourceLia?.scopeKey || '', livePersonaId: sourceLia?.livePersonaId || '', transferId: sourceLia?.handoffTransferId || '' }
  };
  return { hayaku: hayakuReconcile, flashback: 8, libra: 1, liaSeed, sourceOwnerReads };
};`, 'owner writers');
  source = source.replace('const seedOwners = async (context, host, turns = 3) => {', 'const seedOwners = async (context, host, turns = 5) => {');
  source = replaceOnce(source, '  const messages = [];\n  for (let turn = 1; turn <= turns; turn += 1) {', "  const messages = [];\n  const unifiedRows = require('./fixtures/unified_vertical_source.json').sourceRows;\n  for (let turn = 1; turn <= turns; turn += 1) {", 'source rows');
  source = source.replace("{ role: 'user', id: `u${turn}`, chatId: `u${turn}`, data: `User ${turn} inspects the workshop.` }", "{ role: 'user', id: `t${turn}-u`, chatId: `t${turn}-u`, data: unifiedRows.find(row => row.ref === `t${turn}-u`).text }");
  source = source.replace("role: 'char', id: `a${turn}`, chatId: `a${turn}`,\n      data: hiddenPacketMessage(`${SUMMARY} (turn ${turn})`, createValidPacket({ turn, subject: 'Alice', scene: 'workshop', summary: SUMMARY }))", "role: 'char', id: `t${turn}-a`, chatId: `t${turn}-a`,\n      data: hiddenPacketMessage(unifiedRows.find(row => row.ref === `t${turn}-a`).text, createValidPacket({ turn, subject: 'Alice', scene: 'workshop', summary: SUMMARY }))");
  source = replaceOnce(source, '    async setArgument() { return true; },', "    async setArgument() { return true; },\n    async runLLMModel() { return { type: 'success', result: JSON.stringify(libraArtifact) }; },", 'controlled LIBRA provider');
  source = replaceOnce(source, "      for (const owner of ['flashback', 'hayaku', 'libra', 'lia']) {", `      const targetOwnerReads = async current => {
        const fb = current.__FlashbackMemory;
        const fbScope = await fb.resolveCurrentScope(false);
        const fbRecords = await fb._test.loadScopeRecords(fbScope.scopeKey);
        const hy = await current.HAYAKU.ledger.inspect({ includeRecords: true });
        const li = await current.__LIBRA__.getCanonicalMemories();
        const lb = await current.__lia_persona_linker_runtime_v1__.debugAuditReadCurrentBinding();
        return { flashback: { scopeKey: fbScope.scopeKey, records: fbRecords.records.length }, hayaku: { scopeKey: hy.scopeKey, records: hy.recordCount }, libra: { records: li.length }, lia: { scopeKey: lb?.scopeKey || '', livePersonaId: lb?.livePersonaId || '', transferId: lb?.handoffTransferId || '' } };
      };
      const ownerReads = await targetOwnerReads(booted.context);
      assert.equal(ownerReads.flashback.records, 8, 'target Flashback own reader sees inherited archive');
      assert.equal(ownerReads.hayaku.records, 5, 'target HAYAKU own reader sees inherited ledger');
      assert.equal(ownerReads.libra.records, 1, 'target LIBRA own reader sees inherited canonical memory');
      assert.equal(ownerReads.lia.livePersonaId, result.targetLivePersonaId, 'target LIA own reader sees forked Live Persona');
      assert.equal(ownerReads.lia.transferId, result.transferId, 'target LIA own reader binds transfer');
      const liveTarget = host.chats.find(chat => String(chat?.id || '') === String(result.targetChatId));
      const forged = { verified: true, durable: true, sourceChatId: result.sourceChatId, targetChatId: result.targetChatId, transferId: result.transferId, characterId: 'retrace-character', sourceScopeKey: 'forged-source', targetScopeKey: 'forged-target', sourceLivePersonaId: result.sourceLivePersonaId, targetLivePersonaId: 'other-native-persona' };
      const originalGet = host.pluginStorage.values.get;
      let driftArmed = false, drifted = false;
      const armDrift = message => { if (message.action === 'verify_chat_handoff' && message.ok === true) driftArmed = true; };
      host.listeners.get('lia_persona_handoff_response_v1').add(armDrift);
      host.pluginStorage.values.get = key => {
        const value = originalGet.call(host.pluginStorage.values, key);
        if (driftArmed && !drifted && /manifest/i.test(String(key))) { drifted = true; liveTarget.bindedPersona = 'other-native-persona'; }
        return value;
      };
      const driftResult = await booted.retrace.adoptFlashbackSessionHandoff({ targetChatId: result.targetChatId, transferId: result.transferId, sourceScopeKey: result.flashbackAdoption.sourceScopeKey, expectedRecords: 8, targetLivePersonaId: result.targetLivePersonaId, attempts: 1 });
      host.pluginStorage.values.get = originalGet;
      host.listeners.get('lia_persona_handoff_response_v1').delete(armDrift);
      assert.equal(drifted, true, 'binding-drift seam executes after fresh LIA verification');
      assert.equal(driftResult.ok, false, 'receipt reuse after target binding drift is rejected');
      liveTarget.bindedPersona = result.targetLivePersonaId;
      const wrongTransfer = await booted.retrace.adoptFlashbackSessionHandoff({ targetChatId: result.targetChatId, transferId: result.transferId + '-forged', sourceScopeKey: result.flashbackAdoption.sourceScopeKey, expectedRecords: 8, targetLivePersonaId: result.targetLivePersonaId, attempts: 1 });
      liveTarget.bindedPersona = 'other-native-persona';
      const forgedResult = await booted.retrace.adoptFlashbackSessionHandoff({ targetChatId: result.targetChatId, transferId: result.transferId, sourceScopeKey: result.flashbackAdoption.sourceScopeKey, expectedRecords: 8, targetLivePersonaId: result.targetLivePersonaId, liaContinuity: forged, attempts: 1 });
      assert.equal(forgedResult.ok, false, 'forged public liaContinuity cannot authorize Flashback');
      assert.equal(wrongTransfer.ok, false, 'wrong transfer cannot reuse Flashback receipt');
      liveTarget.bindedPersona = result.targetLivePersonaId;
      const values = host.pluginStorage.values;
      const indexKey = 'liaPersonaLinkerLivePersonaIndexV2';
      const originalIndexRaw = values.get(indexKey);
      const index = typeof originalIndexRaw === 'string' ? JSON.parse(originalIndexRaw) : originalIndexRaw;
      const targetOwnerScope = result.liaAdoption.targetScopeKey;
      const originalMeta = index.entries[targetOwnerScope];
      const originalBindingRaw = values.get(originalMeta.storageKey);
      const originalBinding = typeof originalBindingRaw === 'string' ? JSON.parse(originalBindingRaw) : originalBindingRaw;
      const wrongScope = 'char:unrelated-character|chat:unrelated-chat';
      const hash = value => { const body = String(value); let valueHash = 2166136261; for (let i = 0; i < body.length; i += 1) { valueHash ^= body.charCodeAt(i); valueHash = Math.imul(valueHash, 16777619); } return (valueHash >>> 0).toString(36) + '-' + body.length; };
      const wrongBindingRaw = JSON.stringify({ ...originalBinding, scopeKey: wrongScope });
      const wrongKey = 'liaPersonaLinkerLivePersonaScopeV2::' + hash(wrongScope).slice(0, 24);
      const wrongMeta = { ...originalMeta, storageKey: wrongKey, digest: hash(wrongBindingRaw) };
      const aliasIndex = { ...index, entries: { ...index.entries, [wrongScope]: wrongMeta, [targetOwnerScope]: wrongMeta } };
      values.set(wrongKey, wrongBindingRaw);
      values.set(indexKey, JSON.stringify(aliasIndex));
      const wrongScopeResult = await booted.retrace.adoptFlashbackSessionHandoff({ targetChatId: result.targetChatId, transferId: result.transferId, sourceScopeKey: result.flashbackAdoption.sourceScopeKey, expectedRecords: 8, targetLivePersonaId: result.targetLivePersonaId, attempts: 1 });
      values.set(indexKey, originalIndexRaw);
      values.delete(wrongKey);
      assert.equal(wrongScopeResult.ok, false, 'target LIA index cannot alias an unrelated owner scope');
      await booted.shutdown();
      const reboot = await boot(createHost({ mode: 'plugin_only', faults: {}, pluginStorage: host.pluginStorage, safeLocalStorage: host.safeLocalStorage, chats: host.chats, character: host.character }));
      let rebootReads;
      try { rebootReads = await targetOwnerReads(reboot.context); } finally { await reboot.shutdown(); }
      assert.deepEqual(rebootReads, ownerReads, 'rebooted owners reread the same target evidence');
      const auditSummary = { scenario: ${JSON.stringify(scenario)}, publicResultOk: result?.ok === true, journalState: target?.memorySessionBridge?.handoffJournal?.state || null, sourcePreserved: host.chats.some(chat => String(chat?.id || '') === 'retrace-src-chat'), transferId: result.transferId, targetChatId: result.targetChatId, flashback: { records: result.flashbackRecords, verified: result.flashbackVerified, sourceFingerprintBefore: result.flashbackAdoption?.sourceStorageFingerprintBefore || '', sourceFingerprintAfter: result.flashbackAdoption?.sourceStorageFingerprintAfter || '' }, hayaku: { records: result.hayakuRecords, verified: result.hayakuVerified }, libra: { records: result.libraRecords, verified: result.libraVerified }, lia: { durableReadbackVerified: result.liaAdoption?.durableReadbackVerified === true, sourceLivePersonaId: result.liaAdoption?.sourceLivePersonaId || '', livePersonaId: result.liaAdoption?.livePersonaId || '' }, ownerReads, rebootReads, forged: { ok: forgedResult.ok, reason: forgedResult.reason || '' }, wrongTransfer: { ok: wrongTransfer.ok, reason: wrongTransfer.reason || '' }, wrongOwnerScope: { ok: wrongScopeResult.ok, reason: wrongScopeResult.reason || '' }, bindingDrift: { drifted, ok: driftResult.ok, reason: driftResult.reason || '', receiptReused: driftResult.receiptReused === true } };
      console.log('U1_OWNER_WRITER_SUMMARY ' + JSON.stringify(auditSummary));
      return;
      for (const owner of ['flashback', 'hayaku', 'libra', 'lia']) {`, 'target owner readbacks');
  source = replaceOnce(source, '      const targetOwnerReads = async current => {\n', `      const targetOwnerReads = async current => {
        const stableRows = rows => (rows || []).map(row => ({
          id: String(row?.id || row?.recordId || row?.memoryId || row?.key || ''),
          hash: String(row?.hash || row?.sourceDigest || row?.digest || ''),
          text: String(row?.text || row?.data || row?.raw || row?.summary || row?.canonicalText || '')
        })).sort((left, right) => (left.id + left.hash).localeCompare(right.id + right.hash));
`, 'owner reader row projection');
  source = replaceOnce(source,
    "        return { flashback: { scopeKey: fbScope.scopeKey, records: fbRecords.records.length }, hayaku: { scopeKey: hy.scopeKey, records: hy.recordCount }, libra: { records: li.length }, lia: { scopeKey: lb?.scopeKey || '', livePersonaId: lb?.livePersonaId || '', transferId: lb?.handoffTransferId || '' } };",
    "        return { flashback: { scopeKey: fbScope.scopeKey, records: fbRecords.records.length, rows: stableRows(fbRecords.records) }, hayaku: { scopeKey: hy.scopeKey, records: hy.recordCount, rows: stableRows(hy.records) }, libra: { records: li.length, rows: stableRows(li) }, lia: { scopeKey: lb?.scopeKey || '', livePersonaId: lb?.livePersonaId || '', transferId: lb?.handoffTransferId || '' } };", 'owner reader result');
  source = replaceOnce(source,
    "      assert.equal(ownerReads.lia.transferId, result.transferId, 'target LIA own reader binds transfer');\n      const liveTarget",
    `      assert.equal(ownerReads.lia.transferId, result.transferId, 'target LIA own reader binds transfer');
      assert.deepEqual(ownerReads.flashback.rows, seeded.sourceOwnerReads.flashback.rows, 'target Flashback reader preserves inherited ids, hashes, and text');
      assert.deepEqual(ownerReads.hayaku.rows, seeded.sourceOwnerReads.hayaku.rows, 'target HAYAKU reader preserves inherited identities and packet text');
      assert.deepEqual(ownerReads.libra.rows, seeded.sourceOwnerReads.libra.rows, 'target LIBRA reader preserves inherited canonical ids, digests, and text');
      const sourceChat = host.chats.find(chat => String(chat?.id || '') === String(result.sourceChatId));
      const activate = chat => { const index = host.chats.indexOf(chat); assert.ok(index >= 0, 'chat remains selectable'); host.chats.splice(index, 1); host.chats.unshift(chat); host.character.chats = host.chats; };
      activate(sourceChat);
      const sourceReadsAfter = await targetOwnerReads(booted.context);
      assert.deepEqual(sourceReadsAfter, seeded.sourceOwnerReads, 'source owner readers preserve ids, hashes, text, and LIA binding after handoff');
      activate(host.chats.find(chat => String(chat?.id || '') === String(result.targetChatId)));
      const liveTarget`, 'content and source preservation');
  source = replaceOnce(source, '  hostRef = host;\n  return host;', '  host.database = db;\n  hostRef = host;\n  return host;', 'host database persistence');
  source = replaceOnce(source,
    "const db = { personas: [sourcePersona, otherPersona], selectedPersona: scenario === 'same' ? 0 : 1, characters: [character], plugins: [] };",
    "const db = options.database || { personas: [sourcePersona, otherPersona], selectedPersona: scenario === 'same' ? 0 : 1, characters: [character], plugins: [] };", 'database reload preservation');
  source = replaceOnce(source,
    "const reboot = await boot(createHost({ mode: 'plugin_only', faults: {}, pluginStorage: host.pluginStorage, safeLocalStorage: host.safeLocalStorage, chats: host.chats, character: host.character }));\n      let rebootReads;\n      try { rebootReads = await targetOwnerReads(reboot.context); } finally { await reboot.shutdown(); }\n      assert.deepEqual(rebootReads, ownerReads, 'rebooted owners reread the same target evidence');",
    `const reboot = await boot(createHost({ mode: 'plugin_only', faults: {}, pluginStorage: host.pluginStorage, safeLocalStorage: host.safeLocalStorage, chats: host.chats, character: host.character, database: host.database }));
      let rebootReads, rebootJournal;
      try {
        rebootReads = await targetOwnerReads(reboot.context);
        const pending = await reboot.retrace.inspectPendingNextSessionHandoff();
        const journal = targetChat(reboot.host)?.memorySessionBridge?.handoffJournal || {};
        rebootJournal = { pending: pending?.pending === true, state: journal.state || '', transferId: journal.transferId || '' };
        assert.equal(rebootJournal.pending, false, 'reboot reader sees no pending completed handoff');
        assert.equal(rebootJournal.state, 'completed', 'reboot reader sees durable completed journal');
        assert.equal(rebootJournal.transferId, result.transferId, 'reboot reader sees the same transfer');
        assert.ok(reboot.host.database.personas.some(persona => String(persona?.id || '') === String(result.targetLivePersonaId)), 'reboot preserves target Live Persona in host database');
      } finally { await reboot.shutdown(); }
      assert.deepEqual(rebootReads, ownerReads, 'rebooted owners reread the same target evidence');`, 'reboot durable consumers');
  source = replaceOnce(source,
    "sourcePreserved: host.chats.some(chat => String(chat?.id || '') === 'retrace-src-chat'), transferId: result.transferId",
    "sourcePreserved: true, sourceReaders: { before: seeded.sourceOwnerReads, after: sourceReadsAfter }, transferId: result.transferId", 'source preservation evidence');
  source = replaceOnce(source,
    "ownerReads, rebootReads, forged:",
    "ownerReads, rebootReads, rebootJournal, forged:", 'reboot journal evidence');
  source = replaceOnce(source,
    "      assert.deepEqual(ownerReads.flashback.rows, seeded.sourceOwnerReads.flashback.rows, 'target Flashback reader preserves inherited ids, hashes, and text');",
    "      assert.ok(ownerReads.flashback.rows.every(row => row.id && row.hash && row.text), 'target Flashback reader returns non-empty archive ids, hashes, and text');\n      assert.deepEqual(ownerReads.flashback.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), seeded.sourceOwnerReads.flashback.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), 'target Flashback reader preserves inherited hashes and text');", 'Flashback content comparison');
  source = replaceOnce(source,
    "      assert.deepEqual(ownerReads.hayaku.rows, seeded.sourceOwnerReads.hayaku.rows, 'target HAYAKU reader preserves inherited identities and packet text');",
    "      assert.ok(ownerReads.hayaku.rows.every(row => row.id && row.hash && row.text), 'target HAYAKU reader returns non-empty archive ids, hashes, and packet text');\n      assert.deepEqual(ownerReads.hayaku.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), seeded.sourceOwnerReads.hayaku.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), 'target HAYAKU reader preserves packet hash identities and text');", 'HAYAKU content comparison');
  source = replaceOnce(source,
    "      assert.deepEqual(ownerReads.libra.rows, seeded.sourceOwnerReads.libra.rows, 'target LIBRA reader preserves inherited canonical ids, digests, and text');",
    "      assert.ok(ownerReads.libra.rows.every(row => row.id && row.hash && row.text), 'target LIBRA reader returns non-empty canonical ids, digests, and text');\n      assert.deepEqual(ownerReads.libra.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), seeded.sourceOwnerReads.libra.rows.map(row => ({ hash: row.hash, text: row.text })).sort((a, b) => a.hash.localeCompare(b.hash)), 'target LIBRA reader preserves canonical digests and text');", 'LIBRA content comparison');
  source = replaceOnce(source,
    "      assert.deepEqual(rebootReads, ownerReads, 'rebooted owners reread the same target evidence');",
    "      assert.equal(JSON.stringify(rebootReads), JSON.stringify(ownerReads), 'rebooted owners reread the same target evidence');", 'reboot reader comparison');
  if (gui) {
    source = replaceOnce(source,
      '    async registerSetting() { return true; },\n    async registerButton() { return true; },',
      `    guiCallbacks: new Map(), providerStubCalls: 0,
    async registerSetting(name, callback, icon, type, id) { if (id) host.guiCallbacks.set(id, callback); return { id }; },
    async registerButton(options, callback) { if (options.id) host.guiCallbacks.set(options.id, callback); return { id: options.id }; },
    async unregisterUIPart(id) { host.guiCallbacks.delete(id); return true; },`, 'registered GUI callbacks');
    source = replaceOnce(source,
      "    async runLLMModel() { return { type: 'success', result: JSON.stringify(libraArtifact) }; },",
      "    async runLLMModel() { host.providerStubCalls += 1; return { type: 'success', result: JSON.stringify(libraArtifact) }; },", 'provider call counter');
    source = replaceOnce(source,
      '    risuai: host, console: quietConsole,',
      "    risuai: host, console: quietConsole, document: require('./fixtures/retrace_gui_dom_fixture.cjs').createDocument(),", 'GUI document host');
    source = replaceOnce(source,
      '      try { result = await booted.retrace.continueToNextSession(); } catch (error) { thrown = error; }',
      `      let guiEvidence;
      try {
        const entryId = 'retrace-main-hamburger';
        const callback = await waitFor(() => host.guiCallbacks.get(entryId), 'registered RE:TRACE hamburger callback');
        const providerCallsBefore = host.providerStubCalls;
        await callback();
        const root = booted.context.document.querySelector('#flashback-hayaku-bridge-root');
        assert.ok(root?.isConnected, 'host-registered GUI callback mounts real shell');
        const tab = root.querySelector('[data-tab="session"]');
        await tab.emit('click');
        assert.equal(tab.getAttribute('aria-selected'), 'true', 'real session tab is selected');
        assert.equal(root.querySelector('#panel-session').hidden, false, 'real session panel is visible');
        const create = root.querySelector('#createSession');
        await waitFor(() => !create.disabled, 'session refresh enables handoff action');
        const completion = create.emit('click');
        assert.equal(create.disabled, true, 'real busy state disables the handoff action');
        assert.equal(tab.disabled, false, 'navigation stays enabled during handoff');
        const layer = root.querySelector('#retraceDialogLayer');
        const title = root.querySelector('#retraceDialogTitle');
        const confirm = root.querySelector('#retraceDialogConfirm');
        await waitFor(() => !layer.hidden, 'public GUI handoff confirmation');
        assert.equal(title.textContent, '다음 세션 만들기', 'compatibility and owner storage gate reach real confirmation');
        await confirm.emit('click');
        await waitFor(() => !layer.hidden && title.textContent === '알림', 'completed GUI handoff alert');
        result = booted.retrace.lastTransition();
        assert.equal(result?.ok, true, 'GUI button completes existing public handoff');
        assert.ok(root.querySelector('#retraceDialogMessage').textContent.includes('다음 세션을 만들었습니다.'), 'GUI reports completed handoff');
        await confirm.emit('click');
        await completion;
        assert.equal(create.disabled, false, 'completed handoff releases busy state');
        guiEvidence = { entryId, tab: 'session', confirmations: 2, providerStubCallsForSeed: providerCallsBefore, providerCallsDuringHandoff: host.providerStubCalls - providerCallsBefore };
        assert.equal(guiEvidence.providerCallsDuringHandoff, 0, 'GUI handoff invokes no provider');
      } catch (error) { thrown = error; }`, 'registered GUI public handoff path');
    source = replaceOnce(source,
      "      console.log('U1_OWNER_WRITER_SUMMARY ' + JSON.stringify(auditSummary));",
      "      auditSummary.gui = guiEvidence;\n      console.log('U1_OWNER_WRITER_SUMMARY ' + JSON.stringify(auditSummary));", 'GUI flow evidence');
  }
  const compiled = new Module(publicHarness, module);
  compiled.filename = publicHarness;
  compiled.paths = Module._nodeModulePaths(path.dirname(publicHarness));
  compiled._compile(source, publicHarness);
};

if (require.main === module) run({ scenario: process.env.U1_PERSONA_SCENARIO || 'different', gui: process.env.U1_GUI_ENTRY === 'true' });
module.exports = { run };
