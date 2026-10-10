/* LIBRARIAN WHOLE-DATA MIGRATION v1
 * A provider-gated transaction, not the per-owner global-default operation.
 * No source/backup deletion. A host without common authority readers and an
 * atomic source-fenced authority decision must not advertise this provider.
 */
const createMemorySuiteGlobalMigration = provider => {
  'use strict';
  const OWNERS = Object.freeze(['libra', 'hayaku', 'flashback', 'lia', 'retrace']);
  const CONTRACT = 'memory-suite.whole-data-provider.v1';
  const MODES = ['plugin_only', 'server_only'];
  const fail = (code, details) => Object.assign(new Error(code), { code, ...(details ? { details } : {}) });
  const canonical = value => {
    const seen = new Set();
    const walk = item => {
      if (item === null) return 'null';
      if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
      if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
      if (typeof item !== 'object' || seen.has(item) || Object.getOwnPropertySymbols(item).length) throw fail('MIGRATION_VALUE_INVALID');
      const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
      if (prototype !== null) {
        const constructor = Object.getOwnPropertyDescriptor(prototype,'constructor')?.value;
        if (typeof constructor !== 'function'
          || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(array ? Array : Object)
          || (!array && Object.getPrototypeOf(prototype) !== null)) throw fail('MIGRATION_VALUE_INVALID');
        for (let inherited=prototype; inherited; inherited=Object.getPrototypeOf(inherited)) {
          if (Object.getOwnPropertyDescriptor(inherited,'toJSON')) throw fail('MIGRATION_VALUE_INVALID');
        }
      }
      const names = Object.getOwnPropertyNames(item), keys = Object.keys(item);
      if (array ? names.length !== item.length + 1 || keys.length !== item.length : names.length !== keys.length) throw fail('MIGRATION_VALUE_INVALID');
      seen.add(item);
      const read = key => {
        const descriptor = Object.getOwnPropertyDescriptor(item,key);
        if (!descriptor || descriptor.get || descriptor.set || descriptor.enumerable !== true) throw fail('MIGRATION_VALUE_INVALID');
        return walk(descriptor.value);
      };
      const result = array
        ? '[' + Array.from({length:item.length},(_,index)=>read(String(index))).join(',') + ']'
        : '{' + keys.sort().map(key=>JSON.stringify(key)+':'+read(key)).join(',') + '}';
      seen.delete(item);
      return result;
    };
    return walk(value);
  };

  const copy = value => JSON.parse(canonical(value));
  const equal = (a, b) => canonical(a) === canonical(b);
  const keyOf = row => JSON.stringify([row.owner, row.space, row.key]);
  const validText = text => typeof text === 'string' && text.length > 0 && !/[\0\r\n]/.test(text);
  const required = ['durableJournalCAS', 'completeOwnerSnapshots', 'immutableTargetGenerations', 'sealedTargetGenerations', 'atomicAuthorityWithSourceFences', 'sharedAuthorityReaders'];
  if (provider?.contract !== CONTRACT || required.some(key => provider.capabilities?.[key] !== true)) throw fail('MIGRATION_PROVIDER_UNAVAILABLE');
  for (const fn of ['readAuthority', 'capacity', 'writeStagedRecord', 'readStagedGeneration', 'sealStagedGeneration', 'commitAuthority']) if (typeof provider[fn] !== 'function') throw fail('MIGRATION_PROVIDER_UNAVAILABLE');
  for (const fn of ['read', 'compareAndSet']) if (typeof provider.journal?.[fn] !== 'function') throw fail('MIGRATION_JOURNAL_UNAVAILABLE');
  if (!provider.owners || Object.keys(provider.owners).sort().join(',') !== [...OWNERS].sort().join(',')) throw fail('MIGRATION_OWNER_SET_INCOMPLETE');
  for (const owner of OWNERS) for (const fn of ['acquireFence', 'snapshot', 'ready']) if (typeof provider.owners[owner]?.[fn] !== 'function') throw fail('MIGRATION_OWNER_UNAVAILABLE', { owner });
  const authorityValid = row => row?.schema === 'memory-suite.whole-data-authority.v1'
    && Number.isSafeInteger(row.revision) && row.revision >= 0 && row.revision <= Number.MAX_SAFE_INTEGER && MODES.includes(row.mode)
    && validText(row.generation) && (row.operationId === null || validText(row.operationId));
  const readAuthority = async () => {
    const row = copy(await provider.readAuthority());
    if (!authorityValid(row)) throw fail('MIGRATION_AUTHORITY_INVALID');
    return row;
  };
  const validateRecords = (owner, rows) => {
    if (!Array.isArray(rows)) throw fail('MIGRATION_INVENTORY_INCOMPLETE', { owner });
    const seen = new Set();
    return rows.map(input => {
      const row = copy(input);
      if (row.owner !== owner || !['plugin', 'local'].includes(row.space) || !validText(row.key)
        || !['scope', 'orphan', 'global', 'shared'].includes(row.scopeKind) || typeof row.scopeId !== 'string'
        || (row.scopeKind === 'scope' && !validText(row.scopeId)) || typeof row.deleted !== 'boolean'
        || !Object.prototype.hasOwnProperty.call(row, 'value') || (row.deleted && row.value !== null)) throw fail('MIGRATION_RECORD_INVALID', { owner });
      const key = keyOf(row);
      if (seen.has(key)) throw fail('MIGRATION_DUPLICATE_RECORD', { owner });
      seen.add(key);
      return row;
    });
  };
  const normalized = rows => rows.slice().sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  const writeJournal = async (previous, body) => {
    if (previous && (!Number.isSafeInteger(previous.revision) || previous.revision >= Number.MAX_SAFE_INTEGER)) throw fail('MIGRATION_JOURNAL_REVISION_EXHAUSTED');
    const next = { ...body, revision: (previous?.revision || 0) + 1 };
    let accepted, uncertain = false;
    try { accepted = await provider.journal.compareAndSet(next.operationId, previous?.revision ?? null, copy(next)); }
    catch (_) { uncertain = true; }
    let readback;
    try { readback = await provider.journal.read(next.operationId); }
    catch (_) { throw fail('MIGRATION_JOURNAL_UNCERTAIN', { operationId:next.operationId }); }
    if (equal(readback, next)) return next;
    if (uncertain) throw fail('MIGRATION_JOURNAL_UNCERTAIN', { operationId:next.operationId });
    throw fail(accepted === false ? 'MIGRATION_OPERATION_BUSY' : 'MIGRATION_JOURNAL_READBACK_MISMATCH');
  };
  const outcome = row => ({ schema:'memory-suite.whole-data-migration-result.v1', operationId:row.operationId,
    status:row.phase, fromMode:row.source.mode, targetMode:row.targetMode, generation:row.generation,
    authorityRevision:row.phase === 'committed' ? row.nextAuthority.revision : row.source.revision,
    owners:OWNERS.length, records:row.snapshots.reduce((sum, snapshot) => sum + snapshot.records.length, 0),
    sourcePreserved:true, undoAuthority:copy(row.source) });
  const validateJournal = row => {
    try {
      if (!row || row.schema !== 'memory-suite.whole-data-journal.v1' || !validText(row.operationId)
        || !Number.isSafeInteger(row.revision) || row.revision < 1 || !MODES.includes(row.targetMode)
        || !['inventory','staging','ready','commit_intent','committed','cancelled'].includes(row.phase)
        || !authorityValid(row.source) || row.source.revision >= Number.MAX_SAFE_INTEGER || row.source.mode === row.targetMode
        || row.generation !== 'migration-' + row.operationId || !Array.isArray(row.snapshots)
        || row.snapshots.length !== OWNERS.length
        || !equal(row.nextAuthority,{...row.source,revision:row.source.revision+1,mode:row.targetMode,generation:row.generation,operationId:row.operationId})) throw new Error();
      row.snapshots.forEach((snapshot,index) => {
        if(snapshot.owner !== OWNERS[index] || !validText(snapshot.snapshotToken)) throw new Error();
        validateRecords(snapshot.owner,snapshot.records);
      });
      if (['ready','commit_intent','committed'].includes(row.phase)) {
        if (!Array.isArray(row.readiness) || row.readiness.length !== OWNERS.length || !row.seals) throw new Error();
        row.snapshots.forEach((snapshot,index) => {
          const ready=row.readiness[index],seal=row.seals[snapshot.owner];
          if (ready?.owner !== snapshot.owner || ready.ready !== true || ready.snapshotToken !== snapshot.snapshotToken
            || ready.generation !== row.generation || ready.targetMode !== row.targetMode
            || seal?.owner !== snapshot.owner || seal.mode !== row.targetMode || seal.generation !== row.generation
            || seal.snapshotToken !== snapshot.snapshotToken || !validText(seal.sealToken)) throw new Error();
        });
      }
      return copy(row);
    } catch (_) { throw fail('MIGRATION_JOURNAL_INVALID'); }
  };
  const migrate = async ({ operationId, targetMode, signal } = {}) => {
    if (!validText(operationId) || operationId.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(operationId)) throw fail('MIGRATION_OPERATION_ID_INVALID');
    if (!MODES.includes(targetMode)) throw fail('MIGRATION_MODE_INVALID');
    let row = await provider.journal.read(operationId);
    if (row && (row.schema !== 'memory-suite.whole-data-journal.v1' || row.operationId !== operationId || row.targetMode !== targetMode)) throw fail('MIGRATION_OPERATION_ID_CONFLICT');
    if (row) row = validateJournal(row);
    if (row && ['committed', 'cancelled'].includes(row.phase)) return outcome(row);
    let current = await readAuthority();
    if (row?.phase === 'commit_intent') {
      if (equal(current, row.nextAuthority)) {
        row = await writeJournal(row, { ...row, phase:'committed' });
        return outcome(row);
      }
      // A later migration may already have advanced the shared authority.
      // Only the provider's durable decision receipt can prove our old result.
      if (typeof provider.readOperation === 'function') {
        let receipt;
        try { receipt = await provider.readOperation(operationId); } catch (_) {}
        if (receipt?.state === 'committed' && equal(receipt.authority, row.nextAuthority)) {
          row = await writeJournal(row, { ...row, phase:'committed' });
          return outcome(row);
        }
      }
      // Even an old-looking authority may be an indeterminate delayed ACK.
      // No replay is safe without an authoritative durable operation result.
      throw fail('MIGRATION_COMMIT_UNCERTAIN', { operationId });
    }
    if (row && !equal(current, row.source)) throw fail('MIGRATION_AUTHORITY_CHANGED');
    if (!row && current.mode === targetMode) throw fail('MIGRATION_ALREADY_AT_TARGET');
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw fail('MIGRATION_AUTHORITY_REVISION_EXHAUSTED');
    // Resume consumes staging, ready, commit_intent and terminal revisions.
    // Reserve all four before staging, so a commit can always be journalled.
    if (row && row.revision > Number.MAX_SAFE_INTEGER - 4) throw fail('MIGRATION_JOURNAL_REVISION_EXHAUSTED');
    const fences = {}, acquired = [];
    try {
      for (const owner of OWNERS) {
        const fence = await provider.owners[owner].acquireFence({ operationId, authority:copy(current) });
        if (!fence || !validText(fence.token) || typeof fence.assertCurrent !== 'function' || typeof fence.release !== 'function') throw fail('MIGRATION_SOURCE_FENCE_UNAVAILABLE', { owner });
        acquired.push(fence); fences[owner] = fence;
      }
      const assertCurrent = async () => {
        for (const owner of OWNERS) await fences[owner].assertCurrent();
        if (!equal(await readAuthority(), current)) throw fail('MIGRATION_AUTHORITY_CHANGED');
      };
      const snapshots = [];
      for (const owner of OWNERS) {
        const snapshot = await provider.owners[owner].snapshot({ authority:copy(current), fence:fences[owner].token });
        if (snapshot?.owner !== owner || snapshot.complete !== true || snapshot.coverage !== 'all_owner_data_v1'
          || !validText(snapshot.snapshotToken)) throw fail('MIGRATION_INVENTORY_INCOMPLETE', { owner });
        snapshots.push({ owner, snapshotToken:snapshot.snapshotToken, records:validateRecords(owner, snapshot.records) });
      }
      await assertCurrent();
      if (row && !equal(row.snapshots, snapshots)) throw fail('MIGRATION_SOURCE_CHANGED');
      if (!row) {
        const generation = 'migration-' + operationId;
        row = await writeJournal(null, { schema:'memory-suite.whole-data-journal.v1', operationId, phase:'inventory',
          source:current, targetMode, generation, snapshots,
          nextAuthority:{ ...current, revision:current.revision + 1, mode:targetMode, generation, operationId } });
      }
      const cancel = async () => {
        if (!signal?.aborted) return false;
        row = await writeJournal(row, { ...row, phase:'cancelled' });
        return true;
      };
      if (await cancel()) return outcome(row);
      const capacity = await provider.capacity({ mode:targetMode, generation:row.generation });
      const requiredBytes = new TextEncoder().encode(canonical(snapshots)).byteLength;
      const recordCount = snapshots.reduce((sum, snapshot) => sum + snapshot.records.length, 0);
      if (!Number.isFinite(capacity?.availableBytes) || capacity.availableBytes < requiredBytes
        || !Number.isSafeInteger(capacity?.maxRecords) || capacity.maxRecords < recordCount) throw fail('MIGRATION_CAPACITY_UNVERIFIED');
      row = await writeJournal(row, { ...row, phase:'staging' });
      for (const snapshot of snapshots) {
        for (const record of snapshot.records) {
          if (await cancel()) return outcome(row);
          await assertCurrent();
          await provider.writeStagedRecord({ mode:targetMode, generation:row.generation, operationId, record:copy(record) });
        }
        const readback = await provider.readStagedGeneration({ mode:targetMode, generation:row.generation, owner:snapshot.owner });
        if (readback?.complete !== true || !equal(normalized(validateRecords(snapshot.owner, readback.records)), normalized(snapshot.records))) throw fail('MIGRATION_STAGE_READBACK_MISMATCH', { owner:snapshot.owner });
      }
      const seals = {};
      for (const snapshot of snapshots) {
        const seal = await provider.sealStagedGeneration({mode:targetMode,generation:row.generation,
          owner:snapshot.owner,snapshotToken:snapshot.snapshotToken,records:copy(snapshot.records)});
        if (seal?.owner !== snapshot.owner || seal.generation !== row.generation || seal.mode !== targetMode
          || seal.snapshotToken !== snapshot.snapshotToken || !validText(seal.sealToken)) throw fail('MIGRATION_STAGE_SEAL_INVALID');
        const sealed = await provider.readStagedGeneration({mode:targetMode,generation:row.generation,owner:snapshot.owner});
        if (sealed?.complete !== true || !equal(normalized(validateRecords(snapshot.owner,sealed.records)),normalized(snapshot.records))) throw fail('MIGRATION_STAGE_READBACK_MISMATCH');
        seals[snapshot.owner] = copy(seal);
      }
      const readiness = [];
      for (const snapshot of snapshots) {
        const ready = await provider.owners[snapshot.owner].ready({ snapshotToken:snapshot.snapshotToken,
          generation:row.generation, targetMode, fence:fences[snapshot.owner].token });
        if (ready?.owner !== snapshot.owner || ready.ready !== true || ready.snapshotToken !== snapshot.snapshotToken
          || ready.generation !== row.generation || ready.targetMode !== targetMode) throw fail('MIGRATION_OWNER_NOT_READY', { owner:snapshot.owner });
        readiness.push(copy(ready));
      }
      row = await writeJournal(row, { ...row, phase:'ready', readiness, seals });
      if (await cancel()) return outcome(row);
      await assertCurrent();
      row = await writeJournal(row, { ...row, phase:'commit_intent' });
      let accepted;
      try { accepted = await provider.commitAuthority({ expected:copy(current), next:copy(row.nextAuthority),
        operationId, seals:copy(row.seals), fences:Object.fromEntries(OWNERS.map(owner => [owner, fences[owner].token])) }); }
      catch (_) { /* Reconcile the exact decision; never assume an exception means no write. */ }
      try { current = await readAuthority(); } catch (_) { throw fail('MIGRATION_COMMIT_UNCERTAIN', { operationId }); }
      if (!equal(current, row.nextAuthority)) throw fail(accepted === false ? 'MIGRATION_AUTHORITY_CONFLICT' : 'MIGRATION_COMMIT_UNCERTAIN', { operationId });
      row = await writeJournal(row, { ...row, phase:'committed' });
      return outcome(row);
    } finally {
      for (const fence of acquired.reverse()) { try { await fence.release(); } catch (_) { /* A release failure cannot undo the authority decision. */ } }
    }
  };
  return Object.freeze({ contract:CONTRACT, owners:OWNERS, migrate,
    inspectOperation:async operationId => { const row = await provider.journal.read(operationId); return row ? copy(row) : null; } });
};
