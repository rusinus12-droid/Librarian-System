'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict');
const {create, until, pause} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-micro-reader-'));
  const pluginPath = path.join(temporary, 'LIBRA.js');
  fs.writeFileSync(pluginPath, fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8')
    .replace('  const publicApi = Object.freeze({\n    getHostLineageStatus:',
      '  globalThis.__microReaderTest = {LibraMemoryCore,Gui};\n  const publicApi = Object.freeze({\n    getHostLineageStatus:'));
  let fixture, listener, turn = 6, calls = 0;
  try {
    fixture = await create('LIBRA', 'Full', {pluginPath,
      initialChat: input.sourceRows.map(row => ({role: row.role, chatId: row.ref, data: row.text})),
      host: {addRisuChatListener: async (_kind, handler) => { listener = handler; return true; },
        runLLMModel: async () => {
          calls++;
          const active = await fixture.api.debugReadActiveCompletedTurnReceipt(turn);
          if (active.status !== 'verified') return {type: 'success', result: JSON.stringify(artifact())};
          const receipt = active.receipt, quote = receipt.assistant.text;
          const proof = {role: 'assistant', messageId: receipt.assistant.chatId,
            startOffset: 0, endOffset: quote.length, exactQuote: quote};
          return {type: 'success', result: JSON.stringify({schema: 'libra.micro_producer_envelope.v1',
            personCandidates: {spans: [], relations: []}, micro: {schema: 'libra.micro_memory.v1',
              scopeKey: receipt.scopeKey, worldlineId: receipt.worldlineId, sessionEpoch: receipt.sessionEpoch,
              turn, sourceRevisionId: receipt.revisionId, sourceDigest: receipt.sourceDigest,
              claims: [{changeKind: 'event', text: quote, actor: '', target: '', temporalRole: 'current',
                certainty: 'confirmed', epistemicStatus: 'observed', stateChangeType: 'none',
                evidence: turn === 7 ? [proof] : proof}]}})};
        }}});
    const {api, doc, host, context} = fixture;
    await fixture.open();
    assert.equal((await api.runManualColdStart()).completed, 1);
    await pause(400);
    const completedDialog = doc.querySelector('[role="dialog"][aria-label="정본 기억 작업"]');
    [...(completedDialog?.querySelectorAll('button') || [])].find(node => node.textContent.trim() === '확인')?.click();
    await pause(100);
    doc.querySelector('.sidebar [data-go="memory"]').click();
    await until(() => doc.querySelector('[data-memory-reader-kind="micro"]'), 'Micro tab');
    doc.querySelector('[data-memory-reader-kind="micro"]').click();
    await until(() => doc.querySelector('[data-micro-reader-turn="5"]'), 'independent turn list');
    assert.ok(doc.querySelector('.page[data-page="memory"] .page-desc').textContent.includes('Micro'));
    assert.equal(doc.querySelector('.page[data-page="memory"] .page-actions').hidden, true);
    assert.equal(doc.querySelector('[data-micro-reader-turn="5"]').dataset.microReaderStatus, 'missing');
    const character = await host.getCharacter(), chat = character.chats[0];
    const append = body => {
      chat.message.push({role: 'user', chatId: `t${turn}-u`, data: '그다음은?'},
        {role: 'assistant', chatId: `t${turn}-a`, data: body});
      chat.messages = chat.message;
      listener({char: character, chat, characterIndex: 0, chatIndex: 0, messageIndex: chat.message.length - 1});
    };
    append('민아가 서재에서 공연실로 이동했다.');
    await until(() => doc.querySelector('[data-micro-reader-detail="6"][data-analysis-status="verified"]'), 'T6 outside Canonical shown automatically', 15000);
    assert.ok(doc.querySelector('[data-micro-reader-detail]').textContent.includes('민아가 서재에서 공연실로 이동했다.'));
    assert.ok(doc.querySelector('[data-micro-reader-detail] blockquote').textContent.includes('민아가 서재에서 공연실로 이동했다.'));
    const saveView = name => {
      if (!process.env.LIBRA_MICRO_READER_ARTIFACT_DIR) return;
      fs.mkdirSync(process.env.LIBRA_MICRO_READER_ARTIFACT_DIR, {recursive: true});
      const html = doc.documentElement.cloneNode(true);
      html.querySelectorAll('script').forEach(node => node.remove());
      html.querySelector('#outside')?.remove();
      fs.writeFileSync(path.join(process.env.LIBRA_MICRO_READER_ARTIFACT_DIR, name + '.html'), '<!doctype html>' + html.outerHTML);
    };
    saveView('micro-t6');
    assert.equal(context.__microReaderTest.LibraMemoryCore.peekSnapshot().continuityState.throughTurn, 5);
    turn = 7;
    append('민아가 의식을 되찾았다.');
    await until(() => doc.querySelector('[data-micro-reader-detail="7"][data-analysis-status="minimum_source_bound"]'), 'T7 source-only shown automatically', 15000);
    assert.ok(doc.querySelector('[data-micro-reader-detail]').textContent.includes('원문만 보관 · 분석 미완'));
    assert.ok(doc.querySelector('[data-micro-reader-detail] blockquote').textContent.includes('민아가 의식을 되찾았다.'));
    assert.equal(doc.querySelector('[data-micro-reader-detail] [data-micro-reader-claim]'), null);
    saveView('micro-source-only-t7');
    assert.equal(calls, 3);
    const scopeKey = context.__microReaderTest.LibraMemoryCore.peekSnapshot().scope.scopeKey;
    await assert.rejects(api.listMicroReaderTurns({expectedScopeKey: 'another-chat'}), /MICRO_READER_SCOPE_CHANGED/);
    doc.querySelector('[data-micro-reader-turn="6"]').click();
    await until(() => doc.querySelector('[data-micro-reader-detail="6"] [data-micro-reader-claim]'), 'select T6');
    chat.message[11].data = '민아는 계속 서재에 있었다.';
    doc.querySelector('[data-micro-reader-turn="6"]').click();
    await until(() => doc.querySelector('[data-micro-reader-detail="6"]')?.textContent.includes('원문이 변경'), 'stale body excluded');
    assert.equal(doc.querySelector('[data-micro-reader-detail] blockquote'), null);
    // Older pages are read in bounded chunks, without generating missing Micro records.
    for (let n = 8; n <= 25; n++) chat.message.push(
      {role: 'user', chatId: `t${n}-u`, data: '질문 ' + n}, {role: 'assistant', chatId: `t${n}-a`, data: '답변 ' + n});
    const first = await api.listMicroReaderTurns({expectedScopeKey: scopeKey, limit: 999});
    assert.equal(first.items.length, 20); assert.equal(first.items[0].turn, 25); assert.equal(first.hasMore, true);
    const second = await api.listMicroReaderTurns({expectedScopeKey: scopeKey, beforeTurn: first.nextBeforeTurn});
    assert.deepEqual(Array.from(second.items, row => row.turn), [5, 4, 3, 2, 1]);
    assert.equal(second.hasMore, false);
    const refresh = [...doc.querySelectorAll('[data-micro-reader] button')].find(node => node.textContent === '새로고침');
    refresh.click();
    await until(() => doc.querySelector('[data-micro-reader-turn="25"]'), 'latest first page');
    assert.equal(doc.querySelectorAll('[data-micro-reader-turn]').length, 20);
    [...doc.querySelectorAll('[data-micro-reader] button')].find(node => node.textContent === '이전 턴 더 보기').click();
    await until(() => doc.querySelectorAll('[data-micro-reader-turn]').length === 25, 'older page');
    const originalApi = context.__LIBRA__;
    context.__LIBRA__ = {...originalApi, listMicroReaderTurns: async () => { throw new Error('fixture_read_failure'); }};
    [...doc.querySelectorAll('[data-micro-reader] button')].find(node => node.textContent === '새로고침').click();
    await until(() => doc.querySelector('[data-micro-reader] [role="alert"]'), 'list error disclosed');
    assert.equal(doc.querySelectorAll('[data-micro-reader-turn]').length, 25, 'last checked list is retained with an error');
    context.__LIBRA__ = originalApi;
    doc.querySelector('[data-memory-reader-kind="canonical"]').click();
    await until(() => doc.querySelector('[data-canonical-chapter][data-detail-loaded="true"]'), 'Canonical tab still works');
    assert.equal(calls, 3, 'GUI, paging and errors never invoke a model');
    assert.deepEqual(fixture.errors, []);
    console.log('PASS independent Micro GUI: T6/T7 before next Canonical, analysis/source-only, source edits, paging, read errors, no GUI model calls');
    const hostOverrides = fixture.options.host;
    await fixture.close(); fixture = null; turn = 1; calls = 0;
    fixture = await create('LIBRA', 'Full', {pluginPath, host: hostOverrides,
      initialChat: input.sourceRows.slice(0, 2).map(row => ({role: row.role, chatId: row.ref, data: row.text}))});
    await fixture.open();
    await until(() => fixture.doc.querySelector('.sidebar [data-go="memory"]'), 'memory navigation ready');
    const later = [...fixture.doc.querySelectorAll('button')].find(node => node.textContent.trim() === '나중에 하기');
    if (later) { later.click(); await pause(300); }
    fixture.doc.querySelector('.sidebar [data-go="memory"]').click();
    await until(() => fixture.doc.querySelector('[data-memory-reader-kind="micro"]'), 'Micro before Canonical');
    fixture.doc.querySelector('[data-memory-reader-kind="micro"]').click();
    const firstCharacter = await fixture.host.getCharacter();
    listener({char: firstCharacter, chat: firstCharacter.chats[0], characterIndex: 0, chatIndex: 0, messageIndex: 1});
    await until(() => fixture.doc.querySelector('[data-micro-reader-detail="1"][data-analysis-status="verified"]'), 'Micro with no Canonical', 15000);
    assert.equal((await fixture.api.listCanonicalReaderChapters()).items.length, 0);
    assert.ok(fixture.doc.querySelector('[data-micro-reader-detail] blockquote').textContent.includes(input.sourceRows[1].text));
    assert.equal(calls, 1, 'one Micro, no Canonical or GUI model call');
    assert.deepEqual(fixture.errors, []);
    console.log('PASS independent Micro GUI before the first Canonical exists');
  } finally { await fixture?.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
