'use strict';
// Explicit range selection is read-only; execution is the one user action. No tracker ticket exists.
const currentSelection=async f=>{const inv=await f.r.api.listCanonicalBatchRanges();return {allowed:true,scopeKey:inv.scopeKey,mode:'source_edit',ranges:inv.ranges.filter(r=>r.startTurn===1)};};
const applySelection=async(f,selection)=>{try{return await f.r.api.startSelectedCanonicalBatches(selection);}catch(e){return {ok:false,reason:String(e.message||e)};}};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

// Observe the real scheduler and queue without replacing either. Bootstrap-only
// automatic audits are disabled so each test owns its one timer registration.
function expose(source) {
  const replace = (from, to) => {
    assert.equal(source.split(from).length, 2, `unique instrumentation seam: ${from}`);
    source = source.replace(from, to);
  };
  replace('if (deepAuditDue) {', 'if (deepAuditDue && globalThis.__allowBootstrapAudit) {');
  replace('await LibraMemoryCore.readySourceRules();', 'globalThis.__auditCore = LibraMemoryCore;await LibraMemoryCore.readySourceRules();');
  replace('const scheduleDeepBranchAudit = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {',
    'const scheduleDeepBranchAudit = globalThis.__scheduleAudit = (context, pairs, delayMs = BRANCH_DEEP_AUDIT_DELAY_MS) => {');
  replace('const enqueue = (scopeKey, task, queues = state.queues) => {',
    'const enqueue = globalThis.__enqueueAuditTest = (scopeKey, task, queues = state.queues) => {');
  replace('const task = enqueue(scopeKey, async () => {\n          const liveContext',
    'const task = enqueue(scopeKey, async () => {globalThis.__auditEntered = (globalThis.__auditEntered || 0) + 1;\n          const liveContext');
  replace("pairs: livePairs, full: true, background: true, scheduleDeep: false, reason: 'background_deep_audit'\n          }, scheduledAudit);",
    "pairs: livePairs, full: true, background: true, scheduleDeep: false, reason: 'background_deep_audit'\n          }, scheduledAudit);globalThis.__auditCompleted = (globalThis.__auditCompleted || 0) + 1;");
  replace('state.branchAuditInFlight.set(scopeKey, task);',
    'state.branchAuditInFlight.set(scopeKey, task);globalThis.__auditTask = task;');
  replace("warn('LIBRA background branch audit failed', error);",
    "globalThis.__auditError = String(error?.stack || error);warn('LIBRA background branch audit failed', error);");
  // Capture the promises launched by the real startup timers. Assignment only
  // observes them; the production callbacks, delays, queues and writes remain.
  replace('void LibraMemoryCore.purgeLegacyWorldAdditionalData().catch(',
    'void (globalThis.__auditStartupCleanupTask = LibraMemoryCore.purgeLegacyWorldAdditionalData()).catch(');
  replace('void runAutomaticLegacyVectorMigration(options).catch(',
    'void (globalThis.__auditStartupVectorTask = runAutomaticLegacyVectorMigration(options)).catch(');
  return source;
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function within(promise, message, ms = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(predicate, message) {
  const start = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - start < 8000, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function settledStartupMaintenance(f, core) {
  await within((async () => {
    await until(() => f.r.context.__auditStartupCleanupTask && f.r.context.__auditStartupVectorTask,
      'actual startup cleanup and vector migration timers launched their tasks');
    const [cleanup, vector] = await Promise.all([
      f.r.context.__auditStartupCleanupTask, f.r.context.__auditStartupVectorTask
    ]);
    assert.equal(cleanup.schema, 'libra.world_additional_removal.v1');
    assert.equal(cleanup.done, true); assert.equal(cleanup.ok, true);
    assert.deepEqual(Array.from(cleanup.errors), []);
    assert.equal(vector.schema, 'libra.embedding_vector_migration_marker.v1');
    assert.equal(vector.complete, true); assert.equal(vector.interrupted, false);
    assert.deepEqual(Array.from(vector.errors), []);
    const marker = JSON.parse(f.r.values.get('libra:v1:migration:remove-world-additional:v1'));
    assert.equal(marker.done, true); assert.equal(marker.finishedAt, cleanup.finishedAt,
      'cleanup completion is physically durable before observation');
    const vectorMarkers = [...f.r.values.entries()].filter(([key]) => key.startsWith('libra:v1:local-vector-migration:'))
      .map(([, value]) => typeof value === 'string' ? JSON.parse(value) : value);
    const vectorMarker = vectorMarkers.find(value => value.complete === true && value.targetSignature === vector.targetSignature
      && value.finishedAt === vector.finishedAt);
    assert(vectorMarker, 'actual completed vector marker is physically durable');
    // Preserve the former whitelist's exact empty-migration payload obligation,
    // now verified before observation instead of allowing writes under the owner.
    const { startedAt, finishedAt, ...value } = vectorMarker;
    assert.ok(Number.isFinite(Date.parse(startedAt)) && Number.isFinite(Date.parse(finishedAt)));
    assert.deepEqual(JSON.parse(JSON.stringify(value)), {"schema": "libra.embedding_vector_migration_marker.v1", "pluginVersion": "2.3.149", "targetSignature": "ec2917fe:1349", "providerProfileId": "mep_a4ccc727f9674d23", "reason": "embedding_startup_probe", "scanned": 0, "candidates": 0, "migrated": 0, "alreadyCurrent": 0, "missingPayload": 0, "incompatibleSpace": 0, "failures": 0, "bytesPromoted": 0, "complete": true, "errors": [], "interrupted": false}, 'the genuine startup migration has the original exact empty payload');
    assert.equal(core.state.embeddingMigrationPromise, null, 'migration ownership finished');
  })(), 'actual startup registration and physical migration tails settled within the original 8 seconds');
}
async function prepared() {
  const f = await fixture({ transformSource: expose, args: { state_enabled: true } });
  assert.equal((await f.run()).completed, 1);
  f.chat.message[0].data += ' Explicit revision B.';
  const ticket = await currentSelection(f);
  assert.equal(ticket.allowed, true);
  assert.equal((await applySelection(f,ticket)).ok, true);
  const core = f.r.context.__auditCore;
  await settledStartupMaintenance(f, core);
  await Promise.all([...core.state.queues.values()]);
  for (const [name, timer] of core.state.timers) if (name.startsWith('branch_audit:')) {
    f.r.context.clearTimeout(timer); core.state.timers.delete(name);
  }
  return { f, core, context: await core.resolveContext(), approved: f.getManifest().memories['1'] };
}
async function schedule(h) {
  const { f, core, context } = h;
  f.r.context.__auditTask = null;
  assert.equal(f.r.context.__scheduleAudit(context, [], 0), true);
  await until(() => f.r.context.__auditTask, 'scheduler registered its queued callback');
  return { task: f.r.context.__auditTask };
}
async function assertSettled(h, task) {
  assert.equal(await within(task, 'registered scheduled audit must settle within 8 seconds'), true);
  assert.equal(h.f.r.context.__auditCompleted, 1, 'the real callback reached completion');
  assert.equal(h.f.r.context.__auditError, undefined);
  assert.equal(h.core.state.queues.size, 0, 'real scope queue drained');
  assert.equal(h.core.state.branchAuditInFlight.size, 0, 'scheduler ownership released');
}
for (const change of ['changed_native_id', 'rollback']) {
  test(`registered scheduled ${change} audit completes and drains its real queue`, async () => {
    const h = await prepared();
    const { f, approved } = h;
    try {
      const bytes = f.r.values.get(approved.key), calls = f.control.calls.length;
      if (change === 'changed_native_id') f.chat.message[0].chatId = 'replacement-native-user';
      else f.chat.message.splice(6);
      const { task } = await schedule(h);
      await assertSettled(h, task);
      const after = f.getManifest().memories['1'];
      assert.equal(after.status, 'inactive');
      assert.equal(after.key, approved.key);
      assert.equal(after.inactiveReason, change === 'rollback' ? 'rollback_or_incomplete_batch' : 'reroll_or_branch_digest_changed');
      assert.equal(f.r.values.get(approved.key), bytes, 'canonical body is immutable');
      assert.equal(f.control.calls.length, calls, 'automatic audit never invokes the model');
      const replay = f.r.api.getRuntime().lastBranchReconcile;
      assert.equal(replay.changed, true);
      assert.equal(replay.continuityRebuildPending, false, 'state replay did not silently disappear');
      assert.equal(replay.continuityStateAuthority, 'target_canonical_chain');
      assert.equal(f.getHead().throughTurn, 0, 'derived head no longer includes the inactive canonical');
    } finally { await f.r.cleanup(); }
  });
}

const noAuditOptions = { full: true, background: true, scheduleDeep: false };
const pauseTick = () => new Promise(resolve => setTimeout(resolve, 20));

test('direct reconciliation waits for its scope owner even with forged bypass options', async () => {
  const h = await prepared(), { f, core, context } = h;
  const held = deferred(), entered = deferred();
  let direct;
  try {
    assert.equal(core.reconcileCanonicalBranchBeforeRecallUnlocked, undefined, 'unlocked implementation is private');
    assert.equal(f.r.api.reconcileCanonicalBranchBeforeRecallUnlocked, undefined, 'no public unlocked bypass');
    const owner = f.r.context.__enqueueAuditTest(context.scope.scopeKey, async () => { entered.resolve(); await held.promise; });
    await entered.promise;
    const before = f.r.storageWrites.length;
    let finished = false;
    direct = core.reconcileCanonicalBranchBeforeRecall(context, {
      ...noAuditOptions, skipQueue: true, alreadyLocked: true, queueOwner: context.scope.scopeKey
    }).then(result => { finished = true; return result; });
    await pauseTick();
    assert.equal(finished, false, 'unrelated owner cannot be treated as reentrancy');
    // All real startup maintenance settled before this owner was acquired.
    // No physical write is exempt from the waiting reconciliation invariant.
    assert.deepEqual(f.r.storageWrites.slice(before), [],
      'waiting reconciliation has no canonical, derived, or other physical writes');
    f.chat.message[0].chatId = 'replacement-while-waiting';
    held.resolve(); await owner;
    const result = await within(direct, 'direct queued reconciliation settles');
    assert.equal(result.changed, true, 'queued work observes the latest native topology');
    assert.equal(f.getManifest().memories['1'].status, 'inactive');
    assert.equal(f.getHead().throughTurn, 0);
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
  } finally { held.resolve(); if (direct) await direct.catch(() => {}); await f.r.cleanup(); }
});

test('scheduled audit retains physical write ownership and does not lose a queued successor', async () => {
  const h = await prepared(), { f, core, context, approved } = h;
  const store = f.r.context.risuai.pluginStorage, original = store.setItem;
  const held = deferred(), reached = deferred();
  let holding = false;
  try {
    const nativeId = f.chat.message[0].chatId, calls = f.control.calls.length;
    const stalePairs = core.buildPairs(f.chat), staleManifest = f.getManifest();
    store.setItem = async function(key, value) {
      if (!holding && String(key).endsWith(':manifest') && JSON.parse(value)?.memories?.['1']?.status === 'inactive') {
        holding = true; reached.resolve(); await held.promise;
      }
      return original.call(this, key, value);
    };
    f.chat.message[0].chatId = 'replacement-first-audit';
    const { task } = await schedule(h);
    await within(reached.promise, 'real inactive manifest physical write reached');
    assert.equal(core.state.queues.size, 1);
    assert.equal(f.r.context.__auditCompleted || 0, 0);
    assert.equal(f.r.context.__scheduleAudit(context, [], 0), false, 'overlapping scheduled audit is coalesced');
    let successorDone = false;
    const successor = core.reconcileCanonicalBranchBeforeRecall(context, {
      ...noAuditOptions, manifest: staleManifest, pairs: stalePairs
    }).then(result => { successorDone = true; return result; });
    await pauseTick();
    assert.equal(successorDone, false, 'successor waits for the physical tail');
    assert.equal(f.getManifest().memories['1'].status, 'committed', 'held physical write is not reported durable');
    f.chat.message[0].chatId = nativeId;
    held.resolve();
    assert.equal(await within(task, 'scheduled owner completes'), true);
    const result = await within(successor, 'queued successor completes');
    assert.equal(result.changed, true, 'successor loads the actually committed inactive reference');
    assert.equal(result.changes[0].action, 'reactivated_current');
    assert.equal(f.getManifest().memories['1'].status, 'committed');
    assert.equal(f.getManifest().memories['1'].key, approved.key);
    assert.equal(f.getHead().throughTurn, 5);
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
    assert.equal(core.state.branchAuditInFlight.size, 0);
    assert.equal(f.control.calls.length, calls, 'both audits use stored canonical work only');
  } finally { held.resolve(); store.setItem = original; await f.r.cleanup(); }
});

test('replay write failure is reported pending and releases the queue for explicit recovery', async () => {
  const h = await prepared(), { f, core, approved } = h;
  const store = f.r.context.risuai.pluginStorage, original = store.setItem;
  let failures = 0;
  try {
    const bytes = f.r.values.get(approved.key), head = f.getHead(), calls = f.control.calls.length;
    store.setItem = async function(key, value) {
      if (!failures && String(key).endsWith(':continuity-state') && JSON.parse(value)?.throughTurn === 0) {
        failures++; throw new Error('synthetic_replay_write_failure');
      }
      return original.call(this, key, value);
    };
    f.chat.message.splice(6);
    const { task } = await schedule(h);
    assert.equal(await within(task, 'failure callback releases owner'), true);
    const report = f.r.api.getRuntime().lastBranchReconcile;
    assert.equal(failures, 1, 'a real derived storage write failed');
    assert.equal(report.continuityRebuildPending, true);
    assert.equal(report.continuityStateAuthority, 'last_known_non_authoritative');
    assert.equal(report.stateRebuild.ok, false);
    assert.match(report.stateRebuild.reason, /pluginStorage.*continuity-state/, 'physical storage wrapper reports the failed derived key');
    assert.equal(f.getManifest().memories['1'].status, 'inactive');
    assert.equal(f.r.values.get(approved.key), bytes);
    assert.deepEqual(f.getHead(), head, 'failed replay restores its previous derived head');
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
    assert.equal(core.state.branchAuditInFlight.size, 0);
    store.setItem = original;
    const recovered = await within(f.r.api.rebuildWorldManagerState({ reason: 'scheduled_audit_failure_explicit_recovery' }), 'explicit recovery is not starved');
    assert.equal(recovered.ok, true);
    assert.equal(f.getHead().throughTurn, 0);
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
    assert.equal(f.control.calls.length, calls);
  } finally { store.setItem = original; await f.r.cleanup(); }
});

for (const cancel of ['unload', 'scope_switch']) {
  test(`queued scheduled callback exits safely on ${cancel}`, async () => {
    const h = await prepared(), { f, core, context } = h;
    const held = deferred(), entered = deferred();
    try {
      const bytes = f.r.values.get(h.approved.key), manifest = f.clone(f.getManifest()), calls = f.control.calls.length;
      const owner = f.r.context.__enqueueAuditTest(context.scope.scopeKey, async () => { entered.resolve(); await held.promise; });
      await entered.promise;
      f.chat.message[0].chatId = 'replacement-before-cancel';
      const { task } = await schedule(h);
      if (cancel === 'unload') await f.r.cleanup();
      else f.chat.id = f.chat.chatId = 'different-active-chat';
      assert.equal(core.state.queues.size, 1, 'cancellation cannot release an unrelated physical owner');
      held.resolve(); await owner;
      assert.equal(await within(task, 'cancelled queued callback exits'), false);
      assert.equal(f.r.context.__auditCompleted || 0, 0);
      assert.deepEqual(f.getManifest(), manifest);
      assert.equal(f.r.values.get(h.approved.key), bytes);
      await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
      assert.equal(core.state.branchAuditInFlight.size, 0);
      assert.equal(f.control.calls.length, calls);
    } finally { held.resolve(); await f.r.cleanup(); }
  });
}

test('unload during a held physical audit write does not release the queue early', async () => {
  const h = await prepared(), { f, core } = h;
  const store = f.r.context.risuai.pluginStorage, original = store.setItem;
  const held = deferred(), reached = deferred();
  let holding = false;
  try {
    const calls = f.control.calls.length, head = f.getHead();
    store.setItem = async function(key, value) {
      if (!holding && String(key).endsWith(':manifest') && JSON.parse(value)?.memories?.['1']?.status === 'inactive') {
        holding = true; reached.resolve(); await held.promise;
      }
      return original.call(this, key, value);
    };
    f.chat.message.splice(6);
    const { task } = await schedule(h);
    await within(reached.promise, 'physical manifest write reached');
    await f.r.cleanup();
    assert.equal(core.state.queues.size, 1, 'unload does not manufacture physical completion');
    assert.equal(f.r.context.__auditCompleted || 0, 0);
    held.resolve();
    assert.equal(await within(task, 'physical tail drains after unload'), true);
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
    assert.equal(core.state.branchAuditInFlight.size, 0);
    const report = f.r.api.getRuntime().lastBranchReconcile;
    assert.equal(report.continuityRebuildPending, true);
    assert.equal(report.stateRebuild.reason, 'state_rebuild_scope_unavailable');
    assert.deepEqual(f.getHead(), head, 'disposed runtime cannot start a derived replay');
    assert.equal(f.control.calls.length, calls);
  } finally { held.resolve(); store.setItem = original; await f.r.cleanup(); }
});

test('scan preflight reconciles rollback under its existing scope owner', async () => {
  const h = await prepared(), { f, core } = h;
  try {
    const calls = f.control.calls.length;
    f.chat.message.splice(6);
    const result = await within(core.scan({ reason: 'manual_cold_start', allowHistoricalBackfill: true }), 'scan preflight and final audit drain');
    assert.equal(result.ok, true);
    assert.equal(f.getManifest().memories['1'].status, 'inactive');
    assert.equal(f.getHead().throughTurn, 0);
    await until(() => core.state.queues.size === 0, 'all real same-scope replay/maintenance tails drain');
    assert.equal(core.state.queues.size, 0);
    assert.equal(f.control.calls.length, calls);
  } finally { await f.r.cleanup(); }
});

require('./fixtures/libra_scheduled_audit_supersession.cjs').register({test,prepared,deferred,within,until});
