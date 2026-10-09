'use strict';
const path = require('node:path'), fs = require('node:fs'), assert = require('node:assert/strict');
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const { make, flush } = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
(async () => {
    const r = await make(), origin = await r.before(), ledger = r.audit.ledger;
    const scopeKey = origin.scopeKey + '::lock-race';
    const indexKey = ledger.indexKey(scopeKey), physicalSet = r.storage.setItem;
    let release, held = false, indexWrites = 0;
    r.storage.setItem = async (key, value) => {
        if (key === indexKey) {
            indexWrites++;
            if (!held) {
                held = true;
                return await new Promise(resolve => {release = async () => resolve(await physicalSet(key, value));});
            }
        }
        return await physicalSet(key, value);
    };
    const a = ledger.appendObserved({origin, scopeKey, recordId: 'late-A', assistantText: 'Raw receipt A.'});
    await flush(); assert(release, 'A reaches actual index mutation');
    await r.advance(1501);
    const ackA = await a;
    assert.equal(ackA.ok, false, 'caller still receives bounded failure');
    let bSettled = false;
    const b = ledger.appendObserved({origin, scopeKey, recordId: 'later-B', assistantText: 'Raw receipt B.'}).then(x => {bSettled = true; return x;});
    await flush();
    const beforeRelease = {bSettled, indexWrites};
    await release(); await flush();
    const ackB = await b;
    assert.equal(ackB.ok, true);
    const fresh = await make(); fresh.store.clear(); for (const [k,v] of r.store) fresh.store.set(k,v);
    const records = await fresh.audit.ledger.listPending(scopeKey, {limit: 8, oldestFirst: true});
    const evidence = {ackA: {ok: ackA.ok, reason: ackA.reason}, ackB: {ok: ackB.ok, verified: ackB.verified}, beforeRelease, afterReleaseIndexWrites: indexWrites, restartedReceiptIds: records.map(x => x.recordId), rawBPresent: !!fresh.store.get(ackB.recordKey)};
    console.log(JSON.stringify(evidence));
    if (process.env.WM_LOCK_OUT) fs.writeFileSync(process.env.WM_LOCK_OUT, JSON.stringify(evidence, null, 2) + '\n');
    assert(records.some(x => x.recordId === 'later-B'), 'verified B must remain discoverable after late A index completion and restart');
    assert.deepEqual(Array.from(records, x => x.recordId), ['late-A', 'later-B']);
    assert.equal(beforeRelease.bSettled, false, 'same-scope mutation lock stays held until in-flight physical write settles');
    assert.equal(beforeRelease.indexWrites, 1, 'B cannot publish a competing head while A is alive');
})().catch(e => {console.error(e.stack); process.exitCode = 1;});
