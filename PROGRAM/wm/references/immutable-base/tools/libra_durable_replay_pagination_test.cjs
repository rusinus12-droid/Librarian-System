'use strict';
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const { make } = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
(async () => {
    const r = await make(), origin = await r.before(), ledger = r.audit.ledger;
    const handles = [];
    for (let i = 0; i < 100; i++) {
        const h = await ledger.appendObserved({origin, recordId: `page-${i}`, assistantText: `Raw receipt ${i}.`});
        assert(h.ok); handles.push(h);
    }
    let reads = 0, writes = 0;
    const get = r.storage.getItem, set = r.storage.setItem;
    r.storage.getItem = async (...a) => {reads++; return get(...a);};
    r.storage.setItem = async (...a) => {writes++; return set(...a);};
    const legacy = await ledger.listPending(origin.scopeKey, {limit: 8, oldestFirst: true});
    const legacyReads = reads;
    reads = 0;
    const first = await ledger.listPendingPage(origin.scopeKey, {limit: 8});
    const firstReads = reads;
    assert.deepEqual(Array.from(first.records, x => x.recordId), Array.from(legacy, x => x.recordId));
    assert.equal(first.scanned, 8);
    assert.equal(firstReads, 18); // head + first sealed page + 8 raw/status pairs
    assert.equal(legacyReads, 20); // head + all 3 sealed pages + 8 raw/status pairs
    assert.equal(writes, 0);
    // All rejected candidates still advance the cursor without mutating them.
    let cursor = null, inspected = 0, maxReads = 0, pages = 0;
    const rawBefore = handles.map(h => r.store.get(h.recordKey));
    const emitted = [];
    do {
        reads = 0;
        const page = await ledger.listPendingPage(origin.scopeKey, {limit: 8, cursor, acceptRecord: rec => Number(rec.recordId.slice(5)) >= 96});
        maxReads = Math.max(maxReads, reads); pages++; inspected += page.scanned;
        assert(page.scanned <= 32);
        assert(reads <= 67, 'each window reads at most head + two sealed pages + 32 raw/status pairs');
        emitted.push(...page.records.map(x => x.recordId));
        cursor = page.nextCursor;
    } while (cursor);
    assert.equal(inspected, 100);
    assert.deepEqual(emitted, ['page-96', 'page-97', 'page-98', 'page-99']);
    assert.equal(writes, 0);
    handles.forEach((h, i) => assert.equal(r.store.get(h.recordKey), rawBefore[i]));
    // Freeze end100, then append enough to seal the old tail. New records may not
    // extend this sweep; old ordinal offsets still identify the same receipts.
    const frozen = await ledger.listPendingPage(origin.scopeKey, {acceptRecord: () => false});
    assert.equal(frozen.nextCursor.end, 100);
    for (let i = 100; i < 134; i++) assert((await ledger.appendObserved({origin, recordId: `page-${i}`, assistantText: `Raw receipt ${i}.`})).ok);
    cursor = frozen.nextCursor; const frozenIds = [];
    do {
        const page = await ledger.listPendingPage(origin.scopeKey, {cursor, limit: 32});
        frozenIds.push(...page.records.map(x => x.recordId)); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(frozenIds, Array.from({length: 68}, (_, i) => `page-${i + 32}`));
    assert.equal((await ledger.listPendingPage(origin.scopeKey)).nextCursor.end, 134, 'new sweep sees appended records');
    await assert.rejects(ledger.listPendingPage('other-scope', {cursor: frozen.nextCursor}), /cursor scope invalid/);
    // Removed/shrunken journal rejects an old cursor rather than skipping into
    // a different snapshot; a new sweep begins from its own head.
    const indexKey = ledger.indexKey(origin.scopeKey), oldHead = r.store.get(indexKey);
    r.store.set(indexKey, JSON.stringify({version: 2, scopeKey: origin.scopeKey, records: [], pageCount: 0, previousPageKey: ''}));
    await assert.rejects(ledger.listPendingPage(origin.scopeKey, {cursor: frozen.nextCursor}), /cursor invalid/);
    assert.equal((await ledger.listPendingPage(origin.scopeKey)).nextCursor, null);
    r.store.set(indexKey, oldHead);
    // A missing raw payload consumes one bounded inspection and cannot pin
    // the cursor in front of subsequent valid receipts. No deletion is issued
    // by production enumeration itself.
    const missingKey = handles[32].recordKey, savedRaw = r.store.get(missingKey);
    r.store.delete(missingKey);
    const afterMissing = await ledger.listPendingPage(origin.scopeKey, {cursor: frozen.nextCursor});
    assert.deepEqual(Array.from(afterMissing.records, x => x.recordId), Array.from({length: 8}, (_, i) => `page-${33 + i}`));
    r.store.set(missingKey, savedRaw);
    // v1 readers preserve legacy order with a bounded record window, without
    // rewriting the legacy index or raw records merely to enumerate them.
    const refs = handles.map(h => ({recordKey: h.recordKey, recordId: h.recordId}));
    r.store.set(indexKey, JSON.stringify({version: 1, scopeKey: origin.scopeKey, records: refs}));
    writes = 0; const v1 = await ledger.listPendingPage(origin.scopeKey, {acceptRecord: () => false});
    assert.equal(v1.scanned, 32); assert.equal(v1.nextCursor.end, 100); assert.equal(writes, 0);
    const evidence = {legacyReads, firstReads, rejectedSnapshot: {inspected, pages, maxReads}, immutableRaw: true, frozenAppendBoundary: true, invalidationControls: true, legacyV1: true};
    if (process.env.WM_STARVATION_OUT) fs.writeFileSync(process.env.WM_STARVATION_OUT, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
})().catch(e => {console.error(e.stack); process.exitCode = 1;});
