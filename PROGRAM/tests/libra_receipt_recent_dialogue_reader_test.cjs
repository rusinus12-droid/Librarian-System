'use strict';
const assert = require('node:assert/strict');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');

const rows = local => [...local].flatMap(([key, raw]) => {
  try { return [{key, value: JSON.parse(raw)}]; } catch { return []; }
});

(async () => {
  const fixture = await serverFixture({mode: 'plugin_only'});
  try {
    const {f, local} = fixture;
    await f.run();
    assert.equal(typeof f.r.api.debugReadCompletedReceiptSet, 'function', 'common completed receipt reader exists');
    assert.equal(typeof f.r.api.debugProvideRecentDialogueFromReceipts, 'function', 'common formatter exists');
    const receiptKeys = rows(local).filter(row => row.value.schema === 'libra.completed_turn_receipt.v1');
    assert.equal(receiptKeys.length, 5);
    let writes = 0;
    const writeKeys = [];
    const originalSet = fixture.backend.setItem;
    fixture.backend.setItem = async (...args) => {
      const key=String(args[0]);writeKeys.push(key);
      if(key.includes(':source-receipt:')||key.includes(':source-receipt-head:'))writes+=1;
      return originalSet(...args);
    };
    const calls = f.control.calls.length;
    const read = turns => f.r.api.debugReadCompletedReceiptSet({requestedTurns: turns});
    const full = await read([3, 4, 5]);
    assert.equal(full.status, 'complete');
    assert.deepEqual(Array.from(full.pairs, pair => pair.turn), [3, 4, 5]);
    assert.deepEqual(Array.from(full.pairs, pair => pair.user.chatId), ['t3-u', 't4-u', 't5-u']);
    const projection = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full, settings: {liveTailMaxTurns: 3}, route: 'planner'});
    assert.deepEqual(Array.from(projection.receiptReadSet.refs, ref => ref.turn), [3, 4, 5]);
    assert.match(projection.liveTail.transcript, /\[USER chatId=t5-u\]/);
    assert.equal(projection.latestAssistant, full.pairs[2].assistant.text);
    assert.equal(projection.queryScene, projection.liveTail.transcript);
    const legacyBudget = f.r.api.debugBuildLiveTailContext(full.pairs, null,
      {liveTailMaxTurns: 3, liveTailMaxChars: 4000}, 'planner');
    const receiptBudget = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full,
      settings: {liveTailMaxTurns: 3, liveTailMaxChars: 4000}, route: 'planner'}).liveTail;
    assert.equal(receiptBudget.transcript, legacyBudget.transcript, 'same verified U+A text and chronological order');
    assert.equal(receiptBudget.maxChars, legacyBudget.maxChars, 'same character ceiling');
    assert.deepEqual(Array.from(receiptBudget.droppedTurns), Array.from(legacyBudget.droppedTurns));
    assert.equal(writes, 0, 'reader and formatter must not write');
    assert.equal(f.control.calls.length, calls, 'reader and formatter must not schedule analysis');

    // A slow newest row must not hold direct callers past their deadline or
    // erase earlier verified rows in the same requested window.
    const slowKey = receiptKeys.find(row => row.value.turn === 5).key;
    const originalGet = fixture.backend.getItem;
    let releaseSlow;
    const slowGate = new Promise(resolve => { releaseSlow = resolve; });
    let held = false;
    fixture.backend.getItem = async key => {
      if (!held && key === slowKey) { held = true; await slowGate; }
      return originalGet(key);
    };
    try {
      const started = Date.now();
      const timeout = await Promise.race([
        f.r.api.debugReadCompletedReceiptSet({requestedTurns:[3,4,5],deadlineAt:started+80}),
        new Promise((_,reject)=>setTimeout(()=>reject(Error('direct receipt reader exceeded deadline')),350))
      ]);
      assert.ok(Date.now()-started<300,'direct reader returns under its own bound');
      assert.equal(timeout.status,'partial');
      assert.deepEqual(Array.from(timeout.pairs,row=>row.turn),[3,4]);
      assert.deepEqual(Array.from(timeout.gaps,row=>row.turn),[5]);
    } finally { releaseSlow(); fixture.backend.getItem=originalGet; }
    assert.equal(writes,0,`timed-out read never writes a source receipt: ${JSON.stringify(writeKeys)}`);

    local.delete(receiptKeys.find(row => row.value.turn === 4).key);
    const partial = await read([3, 4, 5]);
    assert.equal(partial.status, 'partial');
    assert.deepEqual(Array.from(partial.pairs, pair => pair.turn), [3, 5]);
    assert.deepEqual(Array.from(partial.gaps, gap => gap.turn), [4]);
    const withHole = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: partial, settings: {liveTailMaxTurns: 3}, route: 'planner'});
    assert.match(withHole.liveTail.transcript, /\[TURN 3\]/);
    assert.match(withHole.liveTail.transcript, /\[TURN 5\]/);
    assert.doesNotMatch(withHole.liveTail.transcript, /\[TURN 4\]/);
    assert.equal(withHole.liveTail.completeRequestedCoverage, false);
    const newestMissing = await read([3, 4]);
    assert.equal(f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: newestMissing,
      settings: {}, route: 'planner'}).latestAssistant, '',
      'an older verified assistant cannot impersonate a missing terminal turn');
    assert.equal(writes, 0);
    assert.equal(f.control.calls.length, calls);

    for (const row of receiptKeys) local.delete(row.key);
    const empty = await read([3, 4, 5]);
    assert.equal(empty.status, 'empty');
    assert.deepEqual(Array.from(empty.pairs), []);
    const missing = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: empty, settings: {}, route: 'planner'});
    assert.equal(missing.liveTail, null);
    assert.equal(missing.queryScene, '');
    assert.equal(missing.latestAssistant, '');
    assert.equal(writes, 0);
    assert.equal(f.control.calls.length, calls);
    console.log(JSON.stringify({test:'libra_receipt_recent_dialogue_reader',
      completeTurns:full.pairs.map(pair=>pair.turn),
      userIds:full.pairs.map(pair=>pair.user.chatId),
      assistantIds:full.pairs.map(pair=>pair.assistant.chatId),
      receiptRefs:full.refs.map(ref=>ref.receiptKey),
      charBudget:receiptBudget.maxChars,usedChars:receiptBudget.chars,
      partialTurns:partial.pairs.map(pair=>pair.turn),gapTurns:partial.gaps.map(gap=>gap.turn),
      writeCalls:writes,modelCallsAdded:f.control.calls.length-calls}));
    console.log('PASS receipt reader complete/partial/empty, provenance, no writes or model calls');
  } finally { await fixture.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
