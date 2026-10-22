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
    for (const [label, options] of [
      ['default Classic OFF', {settings: {}, route: 'classic'}],
      ['explicit Classic OFF', {settings: {classicLiveTailEnabled: false}, route: 'classic'}],
      ['legacy Planner alias cannot enable Live Tail', {settings: {}, route: 'planner'}]
    ]) {
      const disabled = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full, ...options});
      assert.equal(disabled.liveTail, null, label);
      assert.match(disabled.queryScene, /\[USER chatId=t5-u\]/, `${label}: query context remains available without raw injection`);
      assert.equal(disabled.receiptReadSet.readSetDigest, full.readSetDigest,
        `${label}: route gating preserves receipt authority`);
    }
    const projection = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full, settings: {classicLiveTailEnabled: true, liveTailMaxTurns: 3}, route: 'classic'});
    assert.deepEqual(Array.from(projection.receiptReadSet.refs, ref => ref.turn), [3, 4, 5]);
    assert.equal(projection.liveTail,null);
    assert.match(projection.queryScene, /\[USER chatId=t5-u\]/);
    assert.equal(projection.latestAssistant, full.pairs[2].assistant.text);
    const response=await f.r.api.getResponseContext({currentInput:'현재 요청'});
    assert.equal(response.values.terminalScene,'','read-only consumer context does not re-export the retrieval dialogue');
    assert.equal(response.values.liveTail,null);
    assert.equal(response.values.currentInput,'현재 요청');
    assert.equal((await f.r.api.validateResponseContext(response)).current,true,'receipt-bound read-only context remains valid');
    const legacyAlias = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full,
      settings: {classicLiveTailEnabled: true, liveTailMaxTurns: 3}, route: 'planner'});
    assert.equal(legacyAlias.queryScene, projection.queryScene,
      'legacy route label normalizes to the same explicitly enabled Classic projection');
    assert.equal(legacyAlias.receiptReadSet.readSetDigest, projection.receiptReadSet.readSetDigest,
      'legacy route label does not change receipt authority');
    const receiptBudget = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: full,
      settings: {classicLiveTailEnabled: true, liveTailMaxTurns: 3, liveTailMaxChars: 4000}, route: 'classic'});
    assert.equal(receiptBudget.liveTail,null);
    assert.ok(receiptBudget.queryScene.length<=4000);
    assert.match(receiptBudget.queryScene,/\[TURN 5\]/);
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
    const withHole = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: partial, settings: {classicLiveTailEnabled: true, liveTailMaxTurns: 3}, route: 'classic'});
    assert.match(withHole.queryScene, /\[TURN 3\]/);
    assert.match(withHole.queryScene, /\[TURN 5\]/);
    assert.doesNotMatch(withHole.queryScene, /\[TURN 4\]/);
    assert.equal(withHole.liveTail,null);
    assert.deepEqual(Array.from(withHole.receiptReadSet.gaps,gap=>gap.turn),[4]);
    const newestMissing = await read([3, 4]);
    assert.equal(f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: newestMissing,
      settings: {classicLiveTailEnabled: true, }, route: 'classic'}).latestAssistant, '',
      'an older verified assistant cannot impersonate a missing terminal turn');
    assert.equal(writes, 0);
    assert.equal(f.control.calls.length, calls);

    for (const row of receiptKeys) local.delete(row.key);
    const empty = await read([3, 4, 5]);
    assert.equal(empty.status, 'empty');
    assert.deepEqual(Array.from(empty.pairs), []);
    const missing = f.r.api.debugProvideRecentDialogueFromReceipts({receiptSet: empty, settings: {classicLiveTailEnabled: true, }, route: 'classic'});
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
      charBudget:4000,usedChars:receiptBudget.queryScene.length,
      partialTurns:partial.pairs.map(pair=>pair.turn),gapTurns:partial.gaps.map(gap=>gap.turn),
      writeCalls:writes,modelCallsAdded:f.control.calls.length-calls}));
    console.log('PASS receipt reader complete/partial/empty, provenance, no writes or model calls');
  } finally { await fixture.cleanup(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
