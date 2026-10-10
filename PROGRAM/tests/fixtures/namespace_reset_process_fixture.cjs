'use strict';
// The hook observes the real fsync+rename result. It does not replace reset logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const children = new Set();
process.on('exit', () => { for (const child of children) child.kill('SIGKILL'); });

async function serverChild() {
  const dataDir = path.resolve(process.env.RESET_CHILD_DATA);
  assert.ok(dataDir.startsWith(path.resolve(require('node:os').tmpdir())), 'only synthetic Temp DATA');
  const journal = path.join(dataDir, 'config', 'namespace-reset.json');
  const originalRename = fs.renameSync;
  let hookCalls = 0;
  if (process.env.RESET_CHILD_PROBE === 'true') {
    fs.renameSync = function(source, target) {
      const result = originalRename.apply(this, arguments);
      if (path.resolve(String(source)) === journal + '.tmp' && path.resolve(String(target)) === journal) {
        hookCalls++;
        const bytes = fs.readFileSync(journal), state = JSON.parse(bytes);
        if (state.pending) {
          process.send({ type: 'checkpoint', hookCalls, afterActualRename: true, journalSha256: hash(bytes),
            id: state.pending.id, completed: state.pending.completed, namespaces: state.pending.namespaces, epochs: state.epochs });
          if (process.env.RESET_CHILD_PAUSE === 'true' && state.pending.completed.length === 2) {
            // The parent proves SIGKILL while this exact after-rename barrier is held.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
            throw new Error('fixture_crash_barrier_expired_without_kill');
          }
        }
      }
      return result;
    };
  }
  let app;
  const watchdog = setTimeout(() => { process.send?.({ type: 'watchdog' }); process.exit(124); }, 30000);
  try {
    const { createMemorySuiteServer } = require('../../server/server.cjs');
    app = createMemorySuiteServer({ host: '127.0.0.1', port: 0, dataDir, autoBackup: false });
    const address = await app.listen();
    process.send({ type: 'ready', port: address.port, pid: process.pid, hookCalls });
    process.on('message', async message => {
      if (message.type !== 'stop') return;
      try { await app.close(); fs.renameSync = originalRename; clearTimeout(watchdog); process.send({ type: 'stopped', hookCalls }); process.disconnect(); }
      catch (error) { console.error(error); process.exitCode = 1; }
    });
  } catch (error) {
    fs.renameSync = originalRename;
    clearTimeout(watchdog);
    if (app) await app.close();
    process.send?.({ type: 'boot-error', error: String(error.stack || error) });
    process.exitCode = 1;
    process.disconnect?.();
  }
}

function spawnServer(dataDir, { probe = false, pause = false } = {}) {
  assert.ok(process.env.NODE_OPTIONS?.includes('no-model-network.cjs'), 'child NODE_OPTIONS guard required');
  assert.ok(process.execArgv.some(arg => arg.includes('no-model-network.cjs')), 'explicit child --require guard inherited');
  const child = fork(__filename, ['--server-child'], { windowsHide: true, silent: true,
    env: { ...process.env, RESET_CHILD_DATA: dataDir, RESET_CHILD_PROBE: String(probe), RESET_CHILD_PAUSE: String(pause) } });
  const events = [], output = [];
  children.add(child);
  child.once('close', () => children.delete(child));
  child.on('message', row => events.push(row));
  child.stdout.on('data', row => output.push(row.toString()));
  child.stderr.on('data', row => output.push(row.toString()));
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  return { child, events, output, closed, async ready(waitFor) {
    return waitFor(() => { const error = events.find(row => row.type === 'boot-error'); if (error) throw new Error(error.error); return events.find(row => row.type === 'ready'); }, 'child actual server listen');
  } };
}
async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return server?.closed;
  if (!server.child.connected) return server.closed;
  server.child.send({ type: 'stop' });
  const timer = setTimeout(() => server.child.kill('SIGKILL'), 10000);
  try { const result = await server.closed; assert.equal(result.code, 0, 'child orderly close'); return result; }
  finally { clearTimeout(timer); }
}
async function killedServer(server) {
  assert.equal(server.child.kill('SIGKILL'), true, 'actual child receives SIGKILL at held durable checkpoint');
  const result = await server.closed;
  assert.equal(result.signal, 'SIGKILL', 'actual killed process close proof');
  return { ...result, pid: server.child.pid, signalRequested: 'SIGKILL' };
}
async function bootstrap(c, url, plugin) { const row = await c.call(url, '/bootstrap', null, plugin); assert.equal(row.status, 200); return row.data; }
async function executePlan(c, url, namespaces, options = {}) {
  const manager = await bootstrap(c, url);
  const planned = await c.call(url, '/v1/manager/reset/plan', { namespaces }, 'flashback_hayaku_bridge', manager.token, null, manager.dataInstanceId);
  assert.equal(planned.status, 200, JSON.stringify(planned));
  const plan = planned.data.result;
  const result = await c.call(url, '/v1/manager/reset/execute', { planId: plan.id, confirmation: plan.confirmation, withoutBackup: options.withoutBackup ?? true }, 'flashback_hayaku_bridge', manager.token, null, manager.dataInstanceId);
  return { manager, plan, result };
}
async function staleEpochs(c, url, dataDir, app) {
  const before = c.snapshot(dataDir, app), results = {};
  const owners = { flashback: 'flashback_memory', hayaku: 'hayaku_locator_continuity', libra: 'libra', lia: 'lia_persona_linker', retrace: 'flashback_hayaku_bridge' };
  for (const [ns, owner] of Object.entries(owners)) {
    const connection = await bootstrap(c, url, owner);
    const rejected = await c.call(url, '/v1/kv/set', { namespace: ns, space: 'plugin', key: 'reset-fixture-forbidden-reupload', value: { forbidden: true }, operationId: ns + '_all5_old_epoch_0000', expectedRevision: 0 }, owner, connection.token, {}, connection.dataInstanceId);
    assert.equal(rejected.status, 409, ns + ': stale epoch refused before reupload');
    assert.match(rejected.data.error, /RESET_RECONNECT_REQUIRED/);
    const read = await c.call(url, '/v1/kv/get?namespace=' + ns + '&space=plugin&key=reset-fixture-live', null, owner, connection.token, before.journal.epochs, connection.dataInstanceId);
    assert.equal(read.status, 200, ns + ': explicit current epoch read succeeds');
    assert.equal(read.data.result.exists, false, ns + ': public backend read remains empty');
    results[ns] = { physicalDataInstanceId: connection.dataInstanceId, resetEpoch: connection.resetEpochs[ns], staleWrite: rejected, freshRead: read };
  }
  assert.deepEqual(c.snapshot(dataDir, app), before, 'all five stale-owner writes leave persisted result exact');
  return results;
}
async function subset(c) {
  const root = c.tempRoot(), dataDir = path.join(root, 'DATA'); let active;
  try {
    active = await c.appAt(dataDir); c.seed(active.app, dataDir);
    const before = c.snapshot(dataDir, active.app), manager = await bootstrap(c, active.url);
    const stalePlan = await c.call(active.url, '/v1/manager/reset/plan', { namespaces: c.NAMESPACES }, 'flashback_hayaku_bridge', manager.token);
    const selected = ['hayaku', 'libra'];
    const execute = await executePlan(c, active.url, selected);
    assert.equal(execute.result.status, 200, JSON.stringify(execute));
    const after = c.snapshot(dataDir, active.app); c.assertCompleted(after, selected, before);
    const rejected = await c.call(active.url, '/v1/manager/reset/execute', { planId: stalePlan.data.result.id, confirmation: stalePlan.data.result.confirmation, withoutBackup: true }, 'flashback_hayaku_bridge', manager.token);
    assert.notEqual(rejected.status, 200);
    assert.match(rejected.data.error, /reset_plan_stale/);
    assert.deepEqual(c.snapshot(dataDir, active.app), after, 'stale plan cannot mutate stores/epochs/journal/catalog');
    return { case: 'subset-two-with-stale-plan', selected, before, after, execute, rejected };
  } finally { if (active) await active.app.close(); c.removeRoot(root); }
}

async function prepare(c, dataDir) {
  const active = await c.appAt(dataDir); c.seed(active.app, dataDir); const before = c.snapshot(dataDir, active.app);
  await active.app.close(); return before;
}
async function interrupted(c, dataDir) {
  const server = spawnServer(dataDir, { probe: true, pause: true });
  let closed = false;
  try {
    const ready = await server.ready(c.waitFor), url = 'http://127.0.0.1:' + ready.port;
    const manager = await bootstrap(c, url), planned = await c.call(url, '/v1/manager/reset/plan', { namespaces: c.NAMESPACES }, 'flashback_hayaku_bridge', manager.token, null, manager.dataInstanceId);
    assert.equal(planned.status, 200);
    const plan = planned.data.result;
    const execute = c.call(url, '/v1/manager/reset/execute', { planId: plan.id, confirmation: plan.confirmation, withoutBackup: true }, 'flashback_hayaku_bridge', manager.token, null, manager.dataInstanceId).catch(error => ({ interruptedTransport: String(error.message) }));
    const checkpoint = await c.waitFor(() => server.events.find(row => row.type === 'checkpoint' && row.completed.length === 2), 'durable completion two barrier', 8000);
    assert.equal(checkpoint.afterActualRename, true);
    assert.equal(checkpoint.id, plan.id);
    const killed = await killedServer(server); closed = true;
    const transport = await execute, persisted = c.snapshot(dataDir);
    assert.deepEqual(persisted.journal.pending.completed, [...c.NAMESPACES].sort().slice(0, 2));
    if (process.env.RESET_COMPOSITION_SOURCE_PINS) {
      assert.equal(persisted.journal.pending.schema,'memory-suite.namespace-reset-job.v2');
      assert.equal(persisted.journal.pending.dataInstanceId,manager.dataInstanceId,'actual initial durable producer physical binding before crash');
      assert.equal(persisted.journal.pending.dataIdentityContract,'memory-suite.physical-data-identity.v1');
    }
    assert.equal(c.hash(fs.readFileSync(path.join(dataDir, 'config', 'namespace-reset.json'))), checkpoint.journalSha256);
    for (const ns of c.NAMESPACES) {
      assert.equal(persisted.journal.epochs[ns], 1, ns + ': fenced before first deletion');
      assert.equal(persisted.stores[ns].kv.length, checkpoint.completed.includes(ns) ? 0 : 3, ns + ': actual committed crash state');
      assert.equal(persisted.stores[ns].operations.length, checkpoint.completed.includes(ns) ? 0 : 4, ns + ': actual operation receipts crash state');
    }
    return { manager, plan, checkpoint, killed, transport, persisted, childEvents: server.events, childOutput: server.output.join('') };
  } finally { if (!closed) await stopServer(server); }
}
function dataTree(root) {
  const rows = [];
  function visit(dir) { for(const name of fs.readdirSync(dir).sort()) { const file=path.join(dir,name),stat=fs.lstatSync(file);if(stat.isDirectory())visit(file);else {assert.ok(stat.isFile());const bytes=fs.readFileSync(file);rows.push({file:path.relative(root,file).replaceAll('\\','/'),bytes:bytes.length,sha256:hash(bytes)});} } }
  visit(root);return rows;
}
async function crash(c, copied = false, variation = '') {
  const root = c.tempRoot(), dataDir = path.join(root, 'DATA'); let server;
  try {
    const before = await prepare(c, dataDir), interruption = await interrupted(c, dataDir);
    let restartDir = dataDir, beforeCopy, beforeCopyTree;
    if (copied) { restartDir = path.join(root, 'COPIED-DATA'); fs.cpSync(dataDir, restartDir, { recursive: true }); beforeCopy = c.snapshot(restartDir); assert.deepEqual(beforeCopy, interruption.persisted, 'copied pending DATA bytes semantically identical before admission'); }
    if (variation === 'alias') { restartDir=path.join(root,'CANONICAL-ALIAS');fs.symlinkSync(dataDir,restartDir,'junction'); }
    if (variation === 'token') fs.writeFileSync(path.join(dataDir,'runtime-token.txt'),crypto.randomBytes(24).toString('base64url')+'\n');
    const { readDataInstanceIdentity } = require('../../server/core/data-instance-identity.cjs');
    const identityBefore = readDataInstanceIdentity(restartDir).dataInstanceId;
    if (copied) assert.notEqual(identityBefore, interruption.manager.dataInstanceId, 'copied DATA actual physical identity differs');
    else assert.equal(identityBefore, interruption.manager.dataInstanceId, 'same canonical DATA authority survives alias/token variation');
    if (copied) beforeCopyTree=dataTree(restartDir);
    server = spawnServer(restartDir, { probe: true });
    if(copied && process.env.RESET_COMPOSITION_SOURCE_PINS) {
      const observed=await c.waitFor(()=>server.events.find(row=>row.type==='boot-error'||row.type==='ready'),'candidate copied pending admission');
      const childEvents=server.events,close=await server.closed;server=null;
      assert.equal(observed.type,'boot-error','copied pending rejected before actual listen');
      assert.match(observed.error,/namespace_reset_physical_binding_changed/);
      assert.equal(childEvents.filter(row=>row.type==='checkpoint').length,0,'no reset rename before refusal');
      assert.equal(close.code,1,'expected before-write admission child exit');
      const afterCopyTree=dataTree(restartDir);
      assert.deepEqual(afterCopyTree,beforeCopyTree,'every copied DATA file unchanged before constructor writes');
      const after=c.snapshot(restartDir);
      assert.deepEqual(after,beforeCopy,'all copied pending stores/operations/catalog/epochs/journal/canaries exact');
      assert.deepEqual(c.snapshot(dataDir),interruption.persisted,'source pending DATA exact');
      return {case:'copied-pending-resume-admission-candidate',before,interruption,beforeCopy,after,beforeCopyTree,afterCopyTree,
        sourcePhysicalId:interruption.manager.dataInstanceId,copiedPhysicalId:identityBefore,beforeWriteRejected:true,childEvents,close,mutatedNamespaces:[]};
    }
    const ready = await server.ready(c.waitFor), url = 'http://127.0.0.1:' + ready.port;
    const after = c.snapshot(restartDir), manager = await bootstrap(c, url);
    if (copied) {
      const mutated = c.NAMESPACES.filter(ns => JSON.stringify(beforeCopy.stores[ns]) !== JSON.stringify(after.stores[ns]));
      assert.deepEqual(c.snapshot(dataDir), interruption.persisted, 'original pending DATA remains unchanged while copied DATA is opened');
      const firstMutation = server.events.find(row => row.type === 'checkpoint' && row.completed.length === 3);
      return { case: 'copied-pending-resume-admission', before, interruption, beforeCopy, after,
        sourcePhysicalId: interruption.manager.dataInstanceId, copiedPhysicalId: identityBefore, bootstrapPhysicalId: manager.dataInstanceId,
        beforeWriteRejected: mutated.length === 0, mutatedNamespaces: mutated, firstMutation, childEvents: server.events,
        blocked: mutated.length ? 'COPIED_PENDING_RESET_RESUMED_ON_DIFFERENT_PHYSICAL_DATA_BEFORE_HTTP_LISTEN' : null };
    }
    c.assertCompleted(after, c.NAMESPACES, before);
    assert.equal(after.journal.last.id, interruption.plan.id, 'restart resumes same durable execution ID');
    const stale = await staleEpochs(c, url, restartDir);
    const restartEvents = server.events.slice();
    await stopServer(server); server = null;
    const fresh = await c.appAt(restartDir);
    try { assert.deepEqual(c.snapshot(restartDir, fresh.app), after, 'second actual restart does not repeat reset'); }
    finally { await fresh.app.close(); }
    return { case: 'actual-sigkill-all5-resume'+(variation?'-'+variation:''), before, interruption, after, stale, childEvents: restartEvents, copied: false, variation, physicalId:identityBefore };
  } finally { if (server) await stopServer(server); c.removeRoot(root); }
}
async function physicalPlan(c) {
  const root = c.tempRoot(), a = path.join(root, 'DATA-A'), b = path.join(root, 'DATA-B'); let active, ui;
  try {
    active = await c.appAt(a); c.seed(active.app, a); const beforeA = c.snapshot(a, active.app), port = active.port;
    const connectionA = await bootstrap(c, active.url);
    ui = await c.bootRetrace(active.url);
    let beforeB, connectionB;
    const result = await c.publicReset(ui, { withoutBackup: true, onConfirm: async () => {
      await active.app.close(); active = null;
      fs.cpSync(a, b, { recursive: true });
      active = await c.appAt(b, port); beforeB = c.snapshot(b, active.app); connectionB = await bootstrap(c, active.url);
      assert.notEqual(connectionA.dataInstanceId, connectionB.dataInstanceId, 'same endpoint copied DATA has new actual physical identity');
    } });
    assert.match(result.status, /초기화 중단/, 'actual public handler reports changed physical DATA refusal');
    assert.deepEqual(c.snapshot(a), beforeA, 'old DATA unchanged after physical replacement');
    assert.deepEqual(c.snapshot(b, active.app), beforeB, 'new DATA refusal before reset writes');
    const oldPlanFreshManager = await c.call(active.url, '/v1/manager/reset/execute', { planId: result.plan.id, confirmation: result.plan.confirmation, withoutBackup: true }, 'flashback_hayaku_bridge', connectionB.token, null, connectionB.dataInstanceId);
    assert.notEqual(oldPlanFreshManager.status, 200, 'old process plan rejected with fresh physical binding');
    assert.match(oldPlanFreshManager.data.error, /reset_confirmation_invalid/);
    assert.deepEqual(c.snapshot(b, active.app), beforeB, 'fresh-manager stale plan performs zero reset writes');
    return { case: 'physical-plan-replacement', sourcePhysicalId: connectionA.dataInstanceId, replacedPhysicalId: connectionB.dataInstanceId, result, beforeA, beforeB, oldPlanFreshManager };
  } finally { if (ui) await ui.cleanup(); if (active) await active.app.close(); c.removeRoot(root); }
}
async function probeControl(c) {
  const root = c.tempRoot(), receipts = [];
  try {
    for (const probe of [false, true]) {
      const dataDir = path.join(root, probe ? 'PROBED' : 'PLAIN'), before = await prepare(c, dataDir);
      const server = spawnServer(dataDir, { probe });
      try {
        const ready = await server.ready(c.waitFor), url = 'http://127.0.0.1:' + ready.port;
        const execute = await executePlan(c, url, c.NAMESPACES), after = c.snapshot(dataDir);
        assert.equal(execute.result.status, 200); c.assertCompleted(after, c.NAMESPACES, before);
        receipts.push({ probe, execute, after, events: server.events });
      } finally { await stopServer(server); }
    }
    const meaning = row => ({ stores: Object.fromEntries(c.NAMESPACES.map(ns => [ns, row.after.stores[ns]])), epochs: row.after.journal.epochs,
      pending: row.after.journal.pending, namespaces: row.after.journal.last.namespaces, completed: row.after.journal.last.completed,
      backupChoice: row.after.journal.last.withoutBackup,
      // Independent runs have independent real clocks. Preserve raw timestamps in receipts;
      // verify their validity explicitly and compare actual catalog content/schema here.
      catalogs: row.after.catalogs.map(catalog => {
        assert.ok(Number.isFinite(catalog.updatedAt) && catalog.updatedAt > 0, 'actual catalog publication timestamp valid');
        const { updatedAt, ...content } = catalog; return content;
      }), canaries: row.after.canaries });
    if(process.env.RESET_COMPOSITION_SOURCE_PINS)for(const row of receipts){
      assert.equal(row.after.journal.last.dataInstanceId,row.execute.manager.dataInstanceId,'passive probe result retains actual physical binding');
      assert.equal(row.after.journal.last.schema,'memory-suite.namespace-reset-job.v2');
      assert.equal(row.after.journal.last.dataIdentityContract,'memory-suite.physical-data-identity.v1');
    }
    assert.deepEqual(meaning(receipts[0]), meaning(receipts[1]), 'unpaused exact rename observer preserves reset meaning');
    assert.equal(receipts[0].events.filter(row => row.type === 'checkpoint').length, 0);
    assert.equal(receipts[1].events.filter(row => row.type === 'checkpoint').length, 6, 'real pending plus five completed renames observed');
    return { case: 'passive-probe-control', receipts };
  } finally { c.removeRoot(root); }
}
module.exports.runCase = (name, context) => {
  if (name === 'subset') return subset(context);
  if (name === 'crash') return crash(context);
  if (name === 'alias-crash') return crash(context,false,'alias');
  if (name === 'token-crash') return crash(context,false,'token');
  if (name === 'copied-pending') return crash(context, true);
  if (name === 'physical-plan') return physicalPlan(context);
  if (name === 'probe') return probeControl(context);
  throw new Error('unknown fixture case:' + name);
};
if (process.argv.includes('--server-child')) serverChild().catch(error => { console.error(error); process.exitCode = 1; });
