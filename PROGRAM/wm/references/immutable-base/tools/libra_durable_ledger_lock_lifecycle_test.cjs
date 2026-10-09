'use strict';
const path = require('node:path'), assert = require('node:assert/strict');
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const {make, flush} = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
(async () => {
    for (const outcome of ['resolve-after-b-deadline', 'reject-after-a-deadline']) {
        const r = await make(), origin = await r.before(), ledger = r.audit.ledger;
        const scopeKey = origin.scopeKey + '::' + outcome, indexKey = ledger.indexKey(scopeKey), physicalSet = r.storage.setItem;
        let release, held = false, indexWrites = 0;
        r.storage.setItem = async (key, value) => {
            if (key === indexKey && ++indexWrites === 1) {
                held = true;
                return await new Promise((resolve, reject) => {release = async () => outcome.startsWith('reject') ? reject(new Error('synthetic delayed host failure')) : resolve(await physicalSet(key, value));});
            }
            return await physicalSet(key, value);
        };
        const a = ledger.appendObserved({origin, scopeKey, recordId: 'A', assistantText: 'Raw A.'});
        await flush(); assert(held);
        await r.advance(1501); assert.equal((await a).ok, false);
        let settled = false;
        const b = ledger.appendObserved({origin, scopeKey, recordId: 'B', assistantText: 'Raw B.'}).then(result => {settled = true; return result;});
        await flush(); assert.equal(settled, false); assert.equal(indexWrites, 1);
        // A scope-local fence cannot prevent an independent journal append.
        assert.equal((await ledger.appendObserved({origin, scopeKey: scopeKey + '::independent', recordId: 'C', assistantText: 'Raw C.'})).ok, true);
        if (outcome.startsWith('resolve')) {
            await r.advance(1501);
            assert.equal((await b).ok, false, 'queued caller deadline remains bounded even while physical mutation never settles');
            assert.equal(indexWrites, 1);
            assert.equal(r.store.has(ledger.recordKey(scopeKey, 'B')), false);
            await release(); await flush();
            assert.equal(indexWrites, 1, 'already expired waiter cannot mutate after lock is released');
            assert.equal(r.store.has(ledger.recordKey(scopeKey, 'B')), false);
        } else {
            await release(); await flush();
            assert.equal((await b).ok, true, 'host rejection releases the fence and permits a live waiter');
            assert.equal(indexWrites, 2);
        }
        console.log('PASS ' + outcome + ': bounded ACK, scope isolation and mutation lifetime');
    }
})().catch(error => {console.error(error.stack); process.exitCode = 1;});
