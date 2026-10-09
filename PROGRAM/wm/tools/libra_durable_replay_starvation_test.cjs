'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
// The harness uses actual registered host hooks, ledger, finalization and producer.
process.env.WM_AUDIT_ROOT = path.resolve(__dirname, '..');
const { make, flush } = require('../../fixes/wm-post-response-fixes/capture-boundary-probe.cjs');
const { packet } = require('../../fixes/wm-post-response-fixes/generation-probe.cjs');
const clone = x => JSON.parse(JSON.stringify(x));
const OUT = process.env.WM_STARVATION_OUT;
const stalePrefix = process.env.WM_STALE_PREFIX === '1';
async function restartCase(exhausted = 8) {
    const r = await make();
    const origin = await r.before();
    const raw = 'Mira sees a blue key beyond the stone gate.';
    const exhaustedHandles = [];
    for (let i = 0; i < exhausted; i++) {
        const h = await r.audit.ledger.appendObserved({origin, recordId: `exhausted-${i}`, assistantText: `Older unchanged response ${i}.`});
        assert.equal(h.ok, true);
        assert.equal((await r.audit.ledger.markStatus(h, {status: 'committed', analysisStatus: 'failed', analysisRecoveryAttempt: stalePrefix ? 0 : 2, analysisStartedAt: stalePrefix ? 0 : r.clock.now - 2, analysisFinishedAt: stalePrefix ? 0 : r.clock.now - 1})).ok, true);
        exhaustedHandles.push(h);
    }
    r.chat.message.push({role: 'char', data: raw, chatId: 'assistant-1'});
    const handle = await r.audit.ledger.appendObserved({origin, recordId: origin.requestId, assistantText: raw});
    assert.equal(handle.ok, true);
    const target = {...origin, durableLedgerRecordId: handle.recordId, durableLedgerRecordKey: handle.recordKey};
    const pending = r.audit.pending.registerPending(r.chat, {aiHash: r.api.TokenizerEngine.simpleHash(raw), sourceHash: r.api.TokenizerEngine.simpleHash(raw), aiResponse: raw, aiResponseRaw: raw, userMsgForMemory: origin.canonicalUser.raw, userMsgForNarrative: origin.canonicalUser.raw, messageCount: origin.messageCount, originMessageCount: origin.messageCount, liveMessageIds: [], predictedTurn: 1, allowMemoryCapture: true, allowNarrativeProcessing: true, targetContext: target});
    assert(pending);
    const committed = await r.audit.pending.commitPendingNow(r.char, r.chat, 'afterRequest-starvation-test', {pending, force: true, deferMaintenance: true, suppressFinalizeRetry: true});
    assert.equal(committed.status, 'finalized');
    assert.equal((await r.audit.ledger.readRecord(handle)).record.analysisStatus, 'queued');
    const before = new Map(r.store), chat = clone(r.chat);
    const fresh = await make();
    fresh.store.clear();
    for (const [k, v] of before) fresh.store.set(k, v);
    Object.assign(fresh.chat, chat);
    let providerCalls = 0, readCount = 0, writeCount = 0;
    const get = fresh.storage.getItem, set = fresh.storage.setItem;
    fresh.storage.getItem = async (...args) => {readCount++; return get(...args);};
    fresh.storage.setItem = async (...args) => {writeCount++; return set(...args);};
    Object.assign(fresh.api.MemoryEngine.CONFIG, {useLLM: true, afterRequestParallelAnalysis: false, analysisRecoveryImmediateAttempts: 0, analysisRecoveryDeferredAttempts: 2, worldAdditionalEnabled: false, storyAuthorEnabled: false, directorEnabled: false});
    const p = packet(1, 'assistant-1');
    p.meta.summary_memory.summary = raw;
    p.memory.events[0].summary = raw;
    p.memory.events[0].evidenceRefs[0].snippet = raw;
    fresh.audit.provider.isConfigured = () => true;
    fresh.audit.provider.call = async () => {providerCalls++; return {content: JSON.stringify({canonicalPacket: p}), finishReason: 'stop'};};
    const mode = process.env.WM_REPLAY_CASE || 'normal';
    if (mode === 'changed-source') fresh.chat.message.at(-1).data += ' Revised host branch.';
    if (mode === 'changed-persona') fresh.chat.bindedPersona = 'typed-persona-b';
    if (mode === 'reset') {
        const key = fresh.api.LibraDataStorage.storageKeyFor(fresh.api.LibraDataStorage.scopeKeyFor(fresh.char, fresh.chat));
        const value = JSON.parse(fresh.store.get(key)); value.resetGeneration = 1; value.entries = [];
        fresh.store.set(key, JSON.stringify(value));
    }
    await fresh.before();
    fresh.audit.replay(origin);
    const began = fresh.clock.now;
    for (let i = 0; i < 100; i++) {
        await fresh.advance(500);
        if ((await fresh.audit.ledger.readRecord(handle)).record.analysisStatus === 'done') break;
    }
    await flush();
    const wakeups = [{trigger: 1, providerCalls, status: (await fresh.audit.ledger.readRecord(handle)).record.analysisStatus}];
    if (stalePrefix && mode === 'normal') {
        // Repeated host wakeups must advance past pre-reservation failures,
        // without consuming attempts or making those failures terminal.
        for (let wake = 0; wake < 3; wake++) {
            await fresh.before(); fresh.audit.replay(origin);
            for (let i = 0; i < 24; i++) await fresh.advance(500);
            wakeups.push({trigger: wake + 2, providerCalls, status: (await fresh.audit.ledger.readRecord(handle)).record.analysisStatus});
        }
    }
    const finished = (await fresh.audit.ledger.readRecord(handle)).record;
    const evidence = {exhausted, mode, stalePrefix, wakeups, providerCalls, status: finished.analysisStatus, simulatedElapsedMs: fresh.clock.now - began, readCount, writeCount};
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
    if (mode !== 'normal') {
        assert.equal(providerCalls, 0, 'changed source/persona/reset cannot reach provider across a paginated restart');
        assert.equal(fresh.store.get(handle.recordKey), before.get(handle.recordKey));
        return evidence;
    }
    assert.equal(providerCalls, 1, `later queued receipt must recover behind ${exhausted} exhausted receipts after restart`);
    assert.equal(finished.analysisStatus, 'done');
    assert.equal(fresh.store.get(handle.recordKey), before.get(handle.recordKey), 'successful recovery preserves raw bytes');
    for (const h of exhaustedHandles) {
        assert.equal(fresh.store.get(h.recordKey), before.get(h.recordKey), 'exhausted raw receipt stays immutable');
        if (!stalePrefix) assert.equal(fresh.store.get(`${h.recordKey}::status`), before.get(`${h.recordKey}::status`), 'failed receipt and retry cap remain unchanged for inspection or explicit new-record reanalysis');
        else {
            const failure = (await fresh.audit.ledger.readRecord(h)).record;
            assert.equal(failure.analysisStatus, 'failed');
            assert.equal(failure.analysisRecoveryAttempt, 0, 'pre-reservation failure does not burn an attempt');
            assert.equal(Number(failure.analysisStartedAt || 0), 0);
        }
    }
    await fresh.before();
    for (let i = 0; i < 10; i++) await fresh.advance(500);
    assert.equal(providerCalls, 1, 'repeated recovery does not replay done or exhausted receipts');
    assert.equal(fresh.state.calls.length, 0, 'no actual model/embedding transport');
    return evidence;
}
if (require.main === module) restartCase(Number(process.env.WM_EXHAUSTED_RECEIPTS || 8)).catch(error => {console.error(error.stack); process.exitCode = 1;});
module.exports = {restartCase};
