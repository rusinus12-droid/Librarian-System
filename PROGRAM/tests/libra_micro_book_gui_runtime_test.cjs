'use strict';
// Full production publication/read APIs and actual DOM. Model outputs are controlled fixtures.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {create, until, pause} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-book-micro-'));
  const pluginPath = path.join(temporary, 'LIBRA.js');
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  fs.writeFileSync(pluginPath, source.replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
    '  globalThis.__bookMicroTest = {LibraMemoryCore,Gui};\n  const publicApi = Object.freeze({\n    getHostLineageStatus:'));
  let fixture, listener, canonicalPhase = true, calls = 0;
  try {
    fixture = await create('LIBRA', 'Full', {pluginPath,
      initialChat: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text})),
      host: {
        addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
        runLLMModel: async () => {
          calls++;
          if (canonicalPhase) return {type: 'success', result: JSON.stringify(artifact())};
          const {receipt} = await fixture.api.debugReadActiveCompletedTurnReceipt(5);
          const quote = receipt.assistant.text;
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
              scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
              turn: 5, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: [{changeKind: 'event', text: quote, actor: '', target: '', temporalRole: 'current',
                certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
                evidence: {role: 'assistant', messageId: receipt.assistant.chatId, startOffset: 0,
                  endOffset: quote.length, exactQuote: quote}}]}})};
        }
      }});
    const {api, doc, context} = fixture;
    assert.equal(typeof api.readActiveMicroMemoryForTurn, 'function', 'Book uses the actual public Micro reader');
    await fixture.open();
    assert.equal((await api.runManualColdStart()).completed, 1);
    await pause(500);
    doc.querySelector('.sidebar [data-go="memory"]').click();
    await until(() => doc.querySelector('[data-canonical-chapter][data-detail-loaded="true"]'), 'Canonical body', 10000);
    const {Gui, LibraMemoryCore: core} = context.__bookMicroTest;
    const canonicalText = String(Gui.canonicalReaderDetail.text || Gui.canonicalReaderDetail.summary || '');
    assert.ok(canonicalText.length > 20);
    assert.equal(doc.querySelector('[data-canonical-chapter] .prose').textContent, canonicalText);
    assert.equal(doc.querySelector('[data-book-turn-evidence] [data-micro-turn="5"]'), null);
    canonicalPhase = false;
    const character = await fixture.host.getCharacter();
    listener({char: character, chat: character.chats[0], characterIndex: 0, chatIndex: 0, messageIndex: 9});
    let active;
    for (let attempt = 0; attempt < 200; attempt++) {
      active = await api.debugReadActiveCompletedTurnReceipt(5);
      if (active.status === 'verified') break;
      await pause(20);
    }
    assert.equal(active.status, 'verified');
    const selection=await api.listReanalysisRanges({kind:'micro'});
    const publication=await api.reanalyzeSelectedRanges({...selection,ranges:selection.ranges.filter(row=>row.start===5)});
    assert.equal(publication.ok,true);
    assert.equal((await api.readActiveMicroMemoryForTurn(5, 'other-scope')).status, 'scope_mismatch');
    const stored = await api.readActiveMicroMemoryForTurn(5, core.peekSnapshot().scope.scopeKey);
    assert.equal(stored.status, 'verified');
    assert.equal(stored.record.claims.length, 1);
    // No chapter click or page reload: publication refreshes the already open chapter.
    await until(() => doc.querySelector('[data-book-turn-evidence] [data-micro-turn="5"]'), 'automatic Micro evidence', 10000);
    const item = doc.querySelector('[data-book-turn-evidence] [data-micro-turn="5"]');
    item.querySelector('summary').click();
    assert.equal(item.open, true);
    assert.ok(item.textContent.includes('단일 턴 근거'));
    assert.ok(item.textContent.includes(stored.record.claims[0].text));
    assert.ok(item.querySelector('blockquote').textContent.includes(stored.record.claims[0].evidence.exactQuote));
    assert.equal(doc.querySelector('[data-canonical-chapter] .prose').textContent, canonicalText);
    await pause(500);
    assert.equal(calls, 2, 'one Canonical and one Micro generation; GUI reads call no model');
    assert.deepEqual(fixture.errors, []);
    console.log('PASS Canonical body + automatically refreshed stored Micro text/quotes in full GUI, scope-bound, no GUI model calls');
  } finally { await fixture?.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
