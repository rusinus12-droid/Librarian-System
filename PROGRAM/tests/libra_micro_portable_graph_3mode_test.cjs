'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {serverFixture} = require('./fixtures/libra_server_runtime_fixture.cjs');
const {waitFor} = require('./fixtures/libra_vm_harness.cjs');

const canonicalize = value => Array.isArray(value)
  ? `[${value.map(canonicalize).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const fallbackDigest = body => {
  let h1 = 0x811c9dc5 >>> 0, h2 = 0x9e3779b9 >>> 0;
  for (let index = 0; index < body.length; index++) {
    const code = body.charCodeAt(index);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code + index;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};
const seal = (value, algorithm) => {
  const body = canonicalize(value);
  const fallback = fallbackDigest(body);
  return algorithm === 'SHA-256'
    ? {algorithm, digest: crypto.createHash('sha256').update(body).digest('hex'), fallbackDigest: fallback}
    : {algorithm: 'FNV1A64-FALLBACK', digest: fallback, fallbackDigest: fallback};
};
const retryBusy = async operation => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!/BUSY/.test(String(error?.code || error?.message || '')) || attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};

(async () => {
  for (const mode of ['plugin_only', 'mirror', 'server_only']) {
    const fx = await serverFixture({mode});
    try {
      let {f} = fx;
      f.control.onCall = async args => String(args[0]?.messages?.[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')
        ? {type: 'error', result: 'controlled Micro provider unavailable'}
        : {type: 'success', result: JSON.stringify(f.control.artifact)};
      assert.equal((await f.run()).completed, 1);
      await require('./fixtures/libra_explicit_micro_retry.cjs').retryHistoricalMicro(f,[1]);
      await waitFor(async () => (await f.r.api.debugReadActiveMicroMemory(1)).status === 'verified', 15000);
      const firstMicro = await f.r.api.debugReadActiveMicroMemory(1);
      assert.equal(firstMicro.record.analysisStatus, 'minimum_source_bound');
      let portable = f.r.context.__LIBRAPortableMemoryBackup;
      assert.ok(portable?.exportCurrentScope && portable?.validateBackup);
      const beforeUpgrade = await retryBusy(() => portable.exportCurrentScope());
      if (mode === 'plugin_only') {
        const legacyHead = {...firstMicro.head};
        delete legacyHead.recallProjection;
        delete legacyHead.recallProjectionDigest;
        fx.local.set(firstMicro.headKey, JSON.stringify(legacyHead));
        f = await fx.restart();
        portable = f.r.context.__LIBRAPortableMemoryBackup;
        const originalGetItem = fx.backend.getItem;
        const headReads = [];
        fx.backend.getItem = async key => {
          if (key === firstMicro.headKey) headReads.push(key);
          return originalGetItem(key);
        };
        try {
          const scene = String(f.chat.message[1].data || '');
          const legacyRecall = await f.r.api.previewUnifiedMemoryRecall(scene);
          assert.ok(Array.from(legacyRecall.memories || []).some(row => row.memory?.kind === 'micro'
            && row.memory?.turnRange?.start === 1),
          'a legacy head with one immutable record is searchable before restore');
          await retryBusy(() => portable.restoreCurrentScope(beforeUpgrade));
          headReads.length = 0;
          const restoredRecall = await f.r.api.previewUnifiedMemoryRecall(scene);
          assert.ok(Array.from(restoredRecall.memories || []).some(row => row.memory?.kind === 'micro'
            && row.memory?.turnRange?.start === 1), 'same-key restore keeps T1 searchable');
          assert.ok(headReads.length >= 2,
            `same-key restore must invalidate the cached head projection: ${headReads.length}`);
        } finally { fx.backend.getItem = originalGetItem; }
      }
      const pendingRetry = JSON.parse(JSON.stringify(beforeUpgrade));
      const workRecord = pendingRetry.records.find(row => row.key === firstMicro.record.workKey);
      assert.ok(workRecord, `${mode}: the source-bound Micro keeps its producer work row`);
      const work = typeof workRecord.value === 'string' ? JSON.parse(workRecord.value) : workRecord.value;
      assert.equal(work.status, 'result_ready');
      assert.ok(work.result && work.resultDigest);
      work.priorResults = [...(work.priorResults || []), {result: work.result,
        resultDigest: work.resultDigest, logicalAttempts: work.logicalAttempts}];
      work.logicalAttempts = Number(work.logicalAttempts) + 1;
      work.status = 'reserved';
      work.phase = 'invoking';
      work.result = null;
      work.resultDigest = '';
      workRecord.value = typeof workRecord.value === 'string' ? JSON.stringify(work) : work;
      workRecord.integrity = seal({key: workRecord.key, value: workRecord.value},
        workRecord.integrity.algorithm);
      const pendingUnsigned = {...pendingRetry};
      delete pendingUnsigned.integrity;
      pendingRetry.integrity = seal(pendingUnsigned, pendingRetry.integrity.algorithm);
      await portable.validateBackup(pendingRetry);
      await portable.previewImport(pendingRetry);
      const forgedPrior = JSON.parse(JSON.stringify(pendingRetry));
      const forgedWorkRecord = forgedPrior.records.find(row => row.key === firstMicro.record.workKey);
      const forgedWork = typeof forgedWorkRecord.value === 'string'
        ? JSON.parse(forgedWorkRecord.value) : forgedWorkRecord.value;
      forgedWork.priorResults[0].resultDigest = 'tampered';
      forgedWorkRecord.value = typeof forgedWorkRecord.value === 'string'
        ? JSON.stringify(forgedWork) : forgedWork;
      forgedWorkRecord.integrity = seal({key: forgedWorkRecord.key, value: forgedWorkRecord.value},
        forgedWorkRecord.integrity.algorithm);
      const forgedPriorUnsigned = {...forgedPrior};
      delete forgedPriorUnsigned.integrity;
      forgedPrior.integrity = seal(forgedPriorUnsigned, forgedPrior.integrity.algorithm);
      await assert.rejects(() => portable.previewImport(forgedPrior),
        /LIBRA_MICRO_HANDOFF_(?:WORK|RECORD)_INVALID|portable_backup_micro_work/,
        `${mode}: a sealed but corrupt retry result cannot authorize the earlier Micro`);
      f.control.onCall = async args => {
        if (!String(args[0]?.messages?.[0]?.content || '').includes('[LIBRA MICRO SOURCE CONTRACT]')) {
          return {type: 'success', result: JSON.stringify(f.control.artifact)};
        }
        const input = JSON.parse(args[0].messages[1].content);
        const exactQuote = input.assistant.text.slice(0, 40);
        return {type: 'success', result: JSON.stringify({
          schema: 'libra.micro_producer_envelope.v1', personCandidates: {spans: [], relations: []},
          micro: {schema: 'libra.micro_memory.v1', ...input.binding,
            claims: [{changeKind: 'event', text: exactQuote, actor: '', target: '',
              temporalRole: 'current', certainty: 'confirmed', epistemicStatus: 'observed',
              stateChangeType: 'none', evidence: {role: 'assistant', messageId: input.assistant.messageId,
                startOffset: 0, endOffset: exactQuote.length, exactQuote}}]}
        })};
      };
      const upgraded = await require('./fixtures/libra_explicit_micro_retry.cjs').retryCurrentMicro(f,1);
      assert.equal(upgraded.status, 'verified');
      assert.notEqual(upgraded.recordKey, firstMicro.recordKey);
      const envelope = await retryBusy(() => portable.exportCurrentScope());
      await portable.validateBackup(envelope);
      const headRecord = envelope.records.find(row => String(row.key).includes(':micro-memory-head:'));
      assert.ok(headRecord, `${mode}: the portable backup carries an active Micro head`);
      const head = typeof headRecord.value === 'string' ? JSON.parse(headRecord.value) : headRecord.value;
      const microRecord = envelope.records.find(row => row.key === head.recordKey);
      assert.ok(microRecord,
        `${mode}: the portable backup carries the referenced immutable Micro`);
      const micro = typeof microRecord.value === 'string' ? JSON.parse(microRecord.value) : microRecord.value;
      assert.ok(envelope.records.some(row => row.key === micro.receiptKey),
        `${mode}: the portable backup carries the source receipt`);
      assert.ok(envelope.records.some(row => row.key === firstMicro.recordKey),
        `${mode}: an older immutable Micro revision survives an upgraded active head`);

      const forged = JSON.parse(JSON.stringify(envelope));
      const forgedHeadRecord = forged.records.find(row => row.key === headRecord.key);
      const forgedHead = typeof forgedHeadRecord.value === 'string'
        ? JSON.parse(forgedHeadRecord.value) : forgedHeadRecord.value;
      forgedHead.recordKey = forged.records.find(row => String(row.key).endsWith(':manifest')).key;
      forgedHeadRecord.value = typeof forgedHeadRecord.value === 'string'
        ? JSON.stringify(forgedHead) : forgedHead;
      forgedHeadRecord.integrity = seal({key: forgedHeadRecord.key, value: forgedHeadRecord.value},
        forgedHeadRecord.integrity.algorithm);
      const unsigned = {...forged};
      delete unsigned.integrity;
      forged.integrity = seal(unsigned, forged.integrity.algorithm);
      await assert.rejects(() => portable.validateBackup(forged),
        /portable_backup_micro_head_record_/,
        `${mode}: a sealed envelope cannot rebind a Micro head to the wrong record`);
      await retryBusy(() => portable.restoreCurrentScope(envelope));
      const epochPrefix = `libra:v1:scope:${firstMicro.record.scopeKey}:portable-restore-journal:micro-recall-epoch:`;
      const localEpochs = [...fx.local].filter(([key]) => key.startsWith(epochPrefix))
        .map(([key, raw]) => ({key, value: JSON.parse(raw)}));
      const remoteEpochs = fx.storedRows().filter(row => row.key.startsWith(epochPrefix));
      if (mode !== 'server_only') assert.ok(localEpochs.some(row => row.value.phase === 'completed'),
        `${mode}: local restore epoch survives checkpoint cleanup`);
      if (mode !== 'plugin_only') assert.ok(remoteEpochs.some(row => row.value.phase === 'completed'),
        `${mode}: server restore epoch survives checkpoint cleanup`);
      if (mode === 'mirror') {
        for (const remote of remoteEpochs) {
          assert.deepEqual(localEpochs.find(row => row.key === remote.key)?.value, remote.value,
            'mirror restore epoch has matching physical copies');
        }
      }
      const restarted = await fx.restart();
      const activeAfterRestore = await restarted.r.api.debugReadActiveMicroMemory(1);
      assert.equal(activeAfterRestore.status, 'verified', `${mode}: restored active Micro passes fresh-bridge readback`);
      assert.equal(activeAfterRestore.recordKey, upgraded.recordKey);
      for (const recordKey of [firstMicro.recordKey, upgraded.recordKey]) {
        if (mode !== 'server_only') assert.ok(fx.local.has(recordKey), `${mode}: local copy keeps ${recordKey}`);
        if (mode !== 'plugin_only') assert.ok(fx.storedRows().some(row => row.key === recordKey),
          `${mode}: server copy keeps ${recordKey}`);
      }
      if (mode === 'mirror') {
        const originalSetItem = fx.backend.setItem;
        let faulted = false;
        fx.backend.setItem = async (key, value) => {
          if (!faulted && String(key).startsWith(epochPrefix) && String(key).endsWith(':completed')) {
            faulted = true;
            throw new Error('injected local restore-epoch write failure');
          }
          return originalSetItem(key, value);
        };
        try {
          await assert.rejects(
            () => retryBusy(() => restarted.r.context.__LIBRAPortableMemoryBackup.restoreCurrentScope(envelope)),
            error => /portable_restore_recall_epoch_/.test(String(error?.message || error))
              && error.code === 'PORTABLE_RESTORE_FAILED_ROLLED_BACK',
            'a one-sided mirror epoch cannot report a completed restore');
        } finally { fx.backend.setItem = originalSetItem; }
        assert.equal(faulted, true, 'the mirror epoch fault was reached');
        assert.equal((await restarted.r.api.debugReadActiveMicroMemory(1)).recordKey, upgraded.recordKey,
          'failed epoch publication preserves the pre-restore active Micro');
        const rollbackEpochs = fx.storedRows().filter(row => row.key.startsWith(epochPrefix)
          && row.value?.phase === 'rolled_back');
        assert.ok(rollbackEpochs.length >= 1, 'mirror rollback leaves a durable Recall invalidation');
        for (const remote of rollbackEpochs) {
          assert.deepEqual(JSON.parse(fx.local.get(remote.key)), remote.value,
            'rolled-back epoch has both physical copies');
        }
      }
      console.log(`PASS Micro portable graph validation in ${mode}`);
    } finally { await fx.cleanup(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
