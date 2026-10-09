'use strict';

// Behavioral replacement for the Risu safety test's historical source literal.
// Read actual emitted artifacts. Only expose closure state; the negative control
// additionally disables the single replay-eligibility ownership decision in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readLedgerReceipts } = require('./libra_generation_capture_receipt_fixture.cjs');

const root = path.resolve(__dirname, '..');
const variants = { full: 'LIBRA World Manager Full.js', min: 'LIBRA World Manager.js' };
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function removeReplayOwnershipGuard(code) {
  const acorn = require('acorn');
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  const found = [];
  function walk(node, inReplay = false, inEligible = false) {
    if (!node || typeof node !== 'object') return;
    inReplay ||= node.type === 'AssignmentExpression' && node.left?.name === 'scheduleDurableTurnReplay';
    inEligible ||= inReplay && node.type === 'VariableDeclarator' && node.id?.name === 'eligible';
    if (inEligible && node.type === 'CallExpression'
        && node.callee?.object?.name === 'PendingTurnManager'
        && node.callee?.property?.name === 'hasPendingReceipt') found.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const item of value) walk(item, inReplay, inEligible);
      else if (value && typeof value === 'object') walk(value, inReplay, inEligible);
    }
  }
  walk(ast);
  assert.equal(found.length, 1, 'mutation identifies exactly one replay ownership decision');
  const node = found[0];
  return { code: code.slice(0, node.start) + 'false' + code.slice(node.end),
    mutation: { start: node.start, end: node.end, removed: code.slice(node.start, node.end), replacement: 'false' } };
}

async function prove(variant, mutate) {
  const file = path.join(root, 'dist', variants[variant]);
  const original = fs.readFileSync(file, 'utf8');
  let mutation = null;
  const helper = path.join(__dirname, 'libra_management_gui_integration_test.cjs');
  const fixtureModule = new Module(helper, module);
  fixtureModule.filename = helper;
  fixtureModule.paths = Module._nodeModulePaths(__dirname);
  fixtureModule.instrumentArtifact = code => {
    assert.equal(sha256(code), sha256(original), 'fixture evaluates the selected actual artifact');
    if (mutate) {
      const changed = removeReplayOwnershipGuard(code);
      mutation = changed.mutation;
      code = changed.code;
    }
    const seam = /await RisuCompat\.addReplacer\((['"])afterRequest\1,\s*libraAfterRequestReplacer\)/g;
    assert.equal([...code.matchAll(seam)].length, 1, 'actual afterRequest registration seam exists once');
    return code.replace(seam, match => '(' + match + ',globalThis.__RISU_REPLAY_GUARD__={scheduleDurableTurnReplay,afterRequestWorkerQueue})');
  };
  const helperSource = fs.readFileSync(helper, 'utf8')
    .replace('const end=code.lastIndexOf', 'code=module.instrumentArtifact(code);const end=code.lastIndexOf')
    .replace("code.lastIndexOf('\\n})();')", "code.lastIndexOf('})();')")
    .replace('PersonaRuntimeCoordinator};', 'PersonaRuntimeCoordinator,PendingTurnManager,DurableTurnLedger,TokenizerEngine,clearAfterRequestMissingRecoveryTimer};');
  assert(helperSource.includes('code=module.instrumentArtifact(code);'), 'artifact transform seam exists');
  assert(helperSource.includes('TokenizerEngine,clearAfterRequestMissingRecoveryTimer};'), 'read-only closure export seam exists');
  fixtureModule._compile(helperSource, helper);
  process.env.LIBRA_GUI_TEST_DIST = file;
  const f = await fixtureModule.exports.loadGui({ nativeInitialization: true });
  try {
    const replay = f.w.__RISU_REPLAY_GUARD__;
    assert(replay, 'actual registered replay state is exposed');
    const transportAttempts = { nativeFetch: 0, fetch: 0 };
    for (const [object, key] of [[f.w.risuai, 'nativeFetch'], [f.w, 'fetch']]) {
      object[key] = async () => { transportAttempts[key]++; throw new Error('replay guard fixture forbids transport'); };
    }
    const clock = { now: Date.now(), timers: new Map(), sequence: 100000 };
    const NativeDate = f.w.Date;
    f.w.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [clock.now])); }
      static now() { return clock.now; }
    };
    f.w.setTimeout = (fn, ms) => {
      const id = ++clock.sequence;
      clock.timers.set(id, { fn, at: clock.now + Math.max(0, ms) });
      return id;
    };
    f.w.clearTimeout = id => clock.timers.delete(id);
    const advance = async ms => {
      clock.now += ms;
      const ready = [...clock.timers].filter(([, timer]) => timer.at <= clock.now);
      for (const [id, timer] of ready) { clock.timers.delete(id); await timer.fn(); }
      await flush();
    };
    const user = 'Mira approaches the stone gate.';
    const answer = 'Mira finds a silver key at the stone gate.';
    f.control.chat.message = f.control.chat.msgs = [{ role: 'user', data: user, m_id: 'risu-guard-user', time: clock.now }];
    await f.callbacks.beforeRequest([{ role: 'user', content: user }], 'model');
    const origin = [...f.api.MemoryState.afterRequestOriginsByType.values()].flat().at(-1);
    assert(origin, 'actual beforeRequest produces an admitted origin');
    f.api.clearAfterRequestMissingRecoveryTimer(f.control.chat.id);
    await advance(75); // Finish the initially empty host-triggered replay.
    assert.equal(replay.afterRequestWorkerQueue.length, 0);

    const owned = await f.api.DurableTurnLedger.appendObserved({ origin, recordId: 'risu-owned', assistantText: answer });
    const unowned = await f.api.DurableTurnLedger.appendObserved({ origin, recordId: 'risu-unowned', assistantText: answer });
    assert.equal(owned.ok, true);
    assert.equal(unowned.ok, true);
    const pending = f.api.PendingTurnManager.registerPending(f.control.chat, {
      aiHash: f.api.TokenizerEngine.simpleHash(answer), sourceHash: f.api.TokenizerEngine.simpleHash(answer),
      aiResponse: answer, aiResponseRaw: answer, userMsgForMemory: user, userMsgForNarrative: user,
      sourceCapture: origin.sourceCapture, originMessageCount: origin.messageCount, messageCount: origin.messageCount,
      requestSequence: origin.requestSequence, predictedTurn: 1, allowMemoryCapture: true, allowNarrativeProcessing: false,
      targetContext: { ...origin, durableLedgerRecordId: owned.recordId, durableLedgerRecordKey: owned.recordKey }
    });
    assert(pending, 'actual pending manager registers the owned receipt');
    const before = readLedgerReceipts(f.store);
    assert.equal(before.length, 2, 'two immutable raw receipts are physically present');
    assert.equal(f.api.PendingTurnManager.hasPendingReceipt(before.find(r => r.recordKey === owned.recordKey)), true);
    assert.equal(f.api.PendingTurnManager.hasPendingReceipt(before.find(r => r.recordKey === unowned.recordKey)), false);
    const raw = new Map([owned, unowned].map(h => [h.recordKey, f.store.get(h.recordKey)]));
    const pendingBefore = JSON.stringify(pending);
    const writesBefore = f.calls.writes.length;
    assert.equal(replay.scheduleDurableTurnReplay(origin), true, 'actual scheduler accepts the explicit replay trigger');
    await advance(75); // Observe admission before the separate 25ms worker drain.

    const queued = Array.from(replay.afterRequestWorkerQueue, job => job.context.replayHandle.recordKey);
    const receipts = readLedgerReceipts(f.store);
    const result = {
      variant, artifact: file, artifactSha256: sha256(original), mutate, mutation,
      ownedReceipt: owned.recordId, unownedReceipt: unowned.recordId,
      queuedReceiptIds: Array.from(replay.afterRequestWorkerQueue, job => job.context.replayHandle.recordId),
      ownedStatus: receipts.find(r => r.recordKey === owned.recordKey).analysisStatus,
      unownedStatus: receipts.find(r => r.recordKey === unowned.recordKey).analysisStatus,
      rawUnchanged: [owned, unowned].every(h => f.store.get(h.recordKey) === raw.get(h.recordKey)),
      samePendingReference: f.api.PendingTurnManager.getPending(f.control.chat) === pending,
      samePendingData: JSON.stringify(pending) === pendingBefore,
      canonicalWrites: f.calls.writes.slice(writesBefore).filter(w => w.key.startsWith('LIBRA_DATA::')).length,
      hostWrites: f.calls.hostWrites.length, transportAttempts
    };
    console.log(JSON.stringify({ observation: result }));
    assert(queued.includes(unowned.recordKey), 'unowned_receipt_is_admitted_to_durable_replay');
    assert.equal(result.unownedStatus, 'replaying', 'unowned receipt gets actual durable replay status');
    assert(!queued.includes(owned.recordKey), 'active_pending_anchor_blocks_durable_replay');
    assert.notEqual(result.ownedStatus, 'replaying', 'owned receipt gets no replay status');
    assert.deepEqual(queued, [unowned.recordKey], 'only the unowned receipt is admitted');
    assert.equal(result.rawUnchanged, true);
    assert.equal(result.samePendingReference, true);
    assert.equal(result.samePendingData, true);
    assert.equal(result.canonicalWrites, 0);
    assert.equal(result.hostWrites, 0);
    assert.deepEqual(result.transportAttempts, { nativeFetch: 0, fetch: 0 });
    console.log(JSON.stringify({ completed: { variant, mutate, artifactSha256: result.artifactSha256 } }));
    return result;
  } finally { f.close(); }
}

function runMatrix() {
  const cases = [];
  for (const variant of Object.keys(variants)) {
    for (const mutate of [false, true]) {
      const args = [__filename, '--case', variant, ...(mutate ? ['--remove-guard'] : [])];
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
      const observationLine = String(child.stdout).split('\n').find(line => line.startsWith('{"observation":'));
      const observation = observationLine ? JSON.parse(observationLine).observation : null;
      const completedLine = String(child.stdout).split('\n').find(line => line.startsWith('{"completed":'));
      const completed = completedLine ? JSON.parse(completedLine).completed : null;
      const validObservation = observation?.variant === variant && observation?.mutate === mutate;
      const intendedFailure = child.status === 1
        && /^AssertionError \[ERR_ASSERTION\]: active_pending_anchor_blocks_durable_replay$/m.test(child.stderr);
      const completeSuccess = child.status === 0 && completed?.variant === variant && completed?.mutate === mutate
        && completed?.artifactSha256 === observation?.artifactSha256;
      const ok = !child.error && !child.signal && validObservation && (mutate ? intendedFailure : completeSuccess);
      cases.push({ variant, mutate, ok, status: child.status, signal: child.signal,
        error: child.error?.message || null, observation, completed, stdout: child.stdout, stderr: child.stderr });
    }
  }
  const report = { ok: cases.every(c => c.ok), cases };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  if (process.argv[2] === '--case') {
    assert(Object.hasOwn(variants, process.argv[3]), 'known artifact variant');
    prove(process.argv[3], process.argv.includes('--remove-guard')).catch(error => { console.error(error.stack); process.exit(1); });
  } else process.exitCode = runMatrix().ok ? 0 : 1;
}
module.exports = { prove, runMatrix, removeReplayOwnershipGuard };
