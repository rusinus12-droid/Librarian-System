'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {create, until, pause} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-state-gui-test-'));
  const pluginPath = path.join(temporary, 'LIBRA.js');
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  fs.writeFileSync(pluginPath, source.replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
    '  globalThis.__stateGuiTest = {LibraMemoryCore,openApprovedStateDialog};\n  const publicApi = Object.freeze({\n    getHostLineageStatus:'));
  let fixture, listener, calls = 0, generationTurn = 6;
  const canonical = artifact();
  for (const turn of [2, 4]) {
    const quote = input.sourceRows.find(row => row.ref === `t${turn}-a`).text;
    canonical.facts.push({tempFactId: `event_${turn}`, domain: 'event', subjectTempRef: 'mina',
      claimKind: 'event', values: {detail: quote}, text: quote, temporalRole: 'current_sequence',
      certainty: 'confirmed', evidenceSpans: [{ref: `t${turn}-a`, quote}]});
  }
  try {
    fixture = await create('LIBRA', 'Full', {pluginPath,
      initialChat: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text})),
      host: {addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
        runLLMModel: async () => {
          calls++;
          const active = await fixture.api.debugReadActiveCompletedTurnReceipt(generationTurn);
          if (active.status !== 'verified') return {type: 'success', result: JSON.stringify(canonical)};
          const receipt = active.receipt, quote = receipt.assistant.text;
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
              scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: 0, turn: generationTurn,
              sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: [{changeKind: 'person', text: quote, actor: '민아', target: '', temporalRole: 'current',
                certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set', stateIntent: {
                  domain: 'character', target: {entityName: '민아'}, field: 'condition', operation: 'set', value: generationTurn === 6 ? '기절했다' : '의식을 되찾았다'
                }, evidence: (proof => generationTurn === 6 ? proof : [proof])({role: 'assistant', messageId: `t${generationTurn}-a`, startOffset: 0,
                  endOffset: quote.length, exactQuote: quote})}, ...(generationTurn === 6 ? [{
                  changeKind: 'world', text: '도서관 문이 열렸다.', actor: '', target: '도서관', temporalRole: 'current',
                  certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'set',
                  stateIntent: {domain: 'world', target: {entityName: '도서관'}, field: 'doorStatus', operation: 'set', value: '열렸다'},
                  evidence: {role: 'assistant', messageId: 't6-a', startOffset: quote.indexOf('도서관'),
                    endOffset: quote.length, exactQuote: quote.slice(quote.indexOf('도서관'))}
                }] : [])]}})};
        }}});
    const {api, doc, context, host} = fixture;
    await fixture.open();
    assert.equal((await api.runManualColdStart()).completed, 1);
    await pause(500);
    const click = async selector => { doc.querySelector(selector).click(); await pause(450); };
    await click('.sidebar [data-go="story"]');
    const labels = () => [...doc.querySelectorAll('[data-subtabs="s"] button')].map(node => node.textContent);
    const expected = ['남은 이야기 1', '사건 연대기 2', '흐름 · 전환 0', '반복 소재 0', '관계 이정표 1', '마무리된 이야기 0'];
    assert.deepEqual(labels(), expected);
    await click('[data-subtabs="s"] [data-subtab="chron"]');
    assert.deepEqual(labels(), expected, 'other tab badges do not inherit the selected group count');
    await click('.sidebar [data-go="people"]');
    await click('[data-subtabs="people"] [data-subtab="now"]');
    const core = context.__stateGuiTest.LibraMemoryCore;
    const dialog = context.__stateGuiTest.openApprovedStateDialog();
    assert.ok(dialog.textContent.includes('T5'));
    const before = JSON.stringify(core.peekSnapshot().continuityState);
    // The fixture returns the live host character/chat through its own API.
    const character = await host.getCharacter();
    const live = character.chats[character.chatPage || 0];
    live.message.push({role: 'user', chatId: 't6-u', data: '민아의 상태가 어떻게 변했어?'},
      {role: 'assistant', chatId: 't6-a', data: '민아가 기절했다. 도서관 문이 열렸다.'});
    live.messages = live.message;
    listener({char: character, chat: live, characterIndex: 0, chatIndex: 0, messageIndex: 11});
    await until(() => doc.querySelector('[data-character-field="condition"]')?.textContent === '기절했다',
      'Micro approval automatically appears in the already open current State tab', 15000);
    assert.equal(api.getCurrentStateHead().throughTurn, 6);
    assert.equal(JSON.stringify(core.peekSnapshot().continuityState), before);
    assert.ok(Number(doc.querySelector('[data-character-evidence]').dataset.evidenceCount) >= 1);
    assert.ok(doc.querySelector('[data-subpanel="now"]').textContent.includes('근거 1개 · T6'));
    assert.equal(doc.querySelector('#dialog-state'), dialog, 'auto refresh preserves the existing status dialog');
    assert.ok(dialog.textContent.includes('T6'));
    assert.ok(dialog.textContent.includes('상태 승인 2개'));
    assert.equal(calls, 2, 'one Canonical and one Micro call; GUI makes no model call');
    await click('.sidebar [data-go="world"]');
    assert.ok(doc.querySelector('[data-libra-product-detail="world"]').textContent.includes('문 상태'),
      'approved Micro properties appear even outside the Canonical field whitelist');
    assert.ok(doc.querySelector('[data-libra-product-detail="world"]').textContent.includes('열렸다'));
    const locationCard = [...doc.querySelectorAll('#world-grid article')].find(node => node.textContent.includes('문 상태'));
    assert.ok(locationCard.textContent.includes('T6'), 'a newer Micro proof advances the world card turn badge');
    await click('.sidebar [data-go="people"]');
    await click('[data-subtabs="people"] [data-subtab="now"]');
    generationTurn = 7;
    live.message.push({role: 'user', chatId: 't7-u', data: '그 뒤 상태는?'},
      {role: 'assistant', chatId: 't7-a', data: '민아가 의식을 되찾았다.'});
    listener({char: character, chat: live, characterIndex: 0, chatIndex: 0, messageIndex: 13});
    await until(() => dialog.textContent.includes('원문만 보관 · 상태 분석 필요'),
      'source-only publication must not be displayed as successful State analysis', 15000);
    assert.equal((await api.debugReadActiveMicroMemory(7)).record.analysisStatus, 'minimum_source_bound');
    assert.equal(api.getCurrentStateHead().throughTurn, 6);
    assert.equal(doc.querySelector('[data-character-field="condition"]').textContent, '기절했다',
      'rejected evidence array cannot replace the approved condition');
    assert.equal(calls, 3);
    assert.deepEqual(fixture.errors, []);
    console.log('PASS full GUI automatically shows admitted Micro State, evidence and independent narrative counts');
  } finally { await fixture?.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
