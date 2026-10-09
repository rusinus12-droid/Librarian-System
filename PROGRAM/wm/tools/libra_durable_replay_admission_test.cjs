'use strict';
const path = require('node:path'), assert = require('node:assert/strict');
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const {make, flush} = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
(async () => {
    const r = await make(), origin = await r.before();
    for (let i = 0; i < 20; i++) assert((await r.audit.ledger.appendObserved({origin, recordId: `admission-${i}`, assistantText: `Unchanged raw ${i}.`})).ok);
    // A duplicate host trigger cannot start a second enumeration while the
    // original one owns this scope. Only eight actual jobs are admitted.
    r.audit.replay(origin);
    assert.equal(r.audit.replay(origin), false);
    await r.advance(75); await flush();
    const admitted = r.audit.queue.map(job => job.context.origin.requestId);
    assert.equal(admitted.length, 8);
    assert.equal(new Set(admitted).size, 8);
    assert.deepEqual(Array.from(admitted), Array.from({length: 8}, (_, i) => `admission-${i}`));
    assert.equal(r.receipts().filter(x => x.analysisStatus === 'replaying').length, 8);
    assert.equal(r.state.calls.length, 0);
    console.log('PASS duplicate scheduling guard and unchanged eight-job admission cap');
    const next = await make(), target = await next.before();
    for (let i = 0; i < 32; i++) {
        const h = await next.audit.ledger.appendObserved({origin: target, recordId: `completed-${i}`, assistantText: `Already done ${i}.`});
        assert(h.ok); assert((await next.audit.ledger.markStatus(h, {analysisStatus: 'done'})).ok);
    }
    const append = id => next.audit.ledger.appendObserved({origin: target, recordId: id, assistantText: `Pending ${id}.`});
    assert((await append('snapshot-tail')).ok);
    next.audit.replay(target); await next.advance(75); await flush();
    assert.equal(next.audit.queue.length, 0, 'first bounded window only examines its32 completed records');
    assert((await append('late-append')).ok);
    await next.advance(75); await flush();
    assert.deepEqual(Array.from(next.audit.queue, job => job.context.origin.requestId), ['snapshot-tail']);
    assert.equal(next.receipts().find(x => x.recordId === 'late-append').analysisStatus, 'pending');
    assert.equal(next.audit.replay(target), true, 'completed fixed sweep releases scope for a later hook');
    await next.advance(75); await next.advance(75); await flush();
    assert.equal(next.receipts().find(x => x.recordId === 'late-append').analysisStatus, 'replaying', 'late append becomes visible on the next trigger');
    console.log('PASS fixed snapshot finishes and later trigger discovers appended receipt');

})().catch(error => {console.error(error.stack); process.exitCode = 1;});
