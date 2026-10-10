'use strict';
// Product change under test: every markStatus call must validate its exact raw
// receipt through readRecord while holding the existing record-key lock.
// Execute the unchanged emitted Full/Min ledger through the existing capture VM.
// Only its in-process physical store is fault-injected; no provider or host
// mirror persistence is exercised, and no production implementation is replaced.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const acorn = require('acorn');

// Test-local copies retain the shared capture fixture's host, store, corpus,
// and fake clock. Replace only its whitespace-dependent lexical exposure.
// There is no reason to instrument afterRequest for raw-ledger-only tests.
const exposedArtifacts = new Map();
let exposureEvidence;
function exposeArtifact(code) {
  if (exposedArtifacts.has(code)) return exposedArtifacts.get(code);
  const ast = acorn.parse(code, { ecmaVersion: 'latest' });
  let boundary, ledgerInitializer;
  const stack = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'VariableDeclaration' && node.declarations.some(row => row.id?.name === 'runtimeApi'
      && row.init?.type === 'CallExpression' && row.init.arguments?.[0]?.type === 'ObjectExpression'
      && row.init.arguments[0].properties.some(property => property.key?.name === 'MemoryEngine'))) {
      assert.equal(boundary, undefined, 'one emitted runtimeApi declaration');
      boundary = node.end;
    }
    if (node.type === 'VariableDeclarator' && node.id?.name === 'DurableTurnLedger') {
      assert.equal(ledgerInitializer, undefined, 'one emitted raw-ledger initializer');
      ledgerInitializer = { start: node.init.start, end: node.init.end };
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) stack.push(...child);
      else if (child && typeof child === 'object') stack.push(child);
    }
  }
  assert(boundary && ledgerInitializer, 'AST locates actual emitted runtime and ledger');
  const injection = ';globalThis.__ANCHOR_MEMO_TEST__={...runtimeApi,DurableTurnLedger,TokenizerEngine};'
    + 'globalThis.__QUEUE_TEST__={corpus:TypedRecallCorpus,index:SemanticRecallIndex,jobs:SemanticRecallJobs,engine:null,persist:persistLoreToActiveChat};';
  const instrumented = code.slice(0, boundary) + injection + code.slice(boundary);
  const offset = ledgerInitializer.start >= boundary ? injection.length : 0;
  const originalLedger = code.slice(ledgerInitializer.start, ledgerInitializer.end);
  assert.equal(instrumented.slice(ledgerInitializer.start + offset, ledgerInitializer.end + offset), originalLedger,
    'every byte of the emitted DurableTurnLedger initializer stays intact');
  exposureEvidence = { method: 'test-only AST lexical exposure after runtimeApi declaration',
    ledgerInitializerSha256: crypto.createHash('sha256').update(originalLedger).digest('hex'),
    ledgerInitializerBytes: Buffer.byteLength(originalLedger), unchangedLedgerInitializer: true };
  exposedArtifacts.set(code, instrumented);
  return instrumented;
}
function localFixture(filename, transform, extras = {}) {
  const filepath = path.join(__dirname, filename);
  const loaded = new Module(filepath, module);
  loaded.filename = filepath; loaded.paths = Module._nodeModulePaths(__dirname);
  Object.assign(loaded, extras);
  loaded._compile(transform(fs.readFileSync(filepath, 'utf8')), filepath);
  return loaded.exports;
}
const recallFixture = localFixture('libra_recall_test_runtime.cjs', source => {
  const begin = source.indexOf('  // Test-only access at the closure boundary;');
  const end = source.indexOf('  const context = {', begin);
  assert(begin >= 0 && end > begin, 'existing recall fixture exposure boundaries');
  return source.slice(0, begin) + '  code = module.exposeArtifact(code);\n' + source.slice(end);
}, { exposeArtifact });
const queueFixture = localFixture('libra_typed_recall_queue_test.cjs', source => {
  const dependency = "const { load, memoryEntry } = require('./libra_recall_test_runtime.cjs');";
  assert(source.includes(dependency), 'existing queue fixture loader dependency');
  source = source.replace(dependency, 'const { load, memoryEntry } = module.recallFixture;');
  const begin = source.indexOf('  r=await load({dist:measurement.dist');
  const end = source.indexOf('\n  if(measurement.observeStages)', begin);
  assert(begin >= 0 && end > begin, 'existing queue fixture exposure boundaries');
  return source.slice(0, begin)
    + '  r=await load({dist:measurement.dist,globals:{Risuai:host,risuai:host}});'
    + source.slice(end);
}, { recallFixture });
const { flush } = queueFixture;
async function captureRuntime(shared, measurement = {}) {
  const r = await queueFixture.runtime(shared, { admittedHost: true, ...measurement });
  r.capture = { ledger: r.api.DurableTurnLedger };
  r.origin = n => ({ requestId: 'capture-request-' + n, scopeKey: r.snapshot.scopeKey, runtimeScopeKey: r.snapshot.scopeKey,
    characterId: r.char.id, characterIndex: 0, chatId: r.chat.id, chatIndex: 0,
    requestSequence: n, requestType: 'model', messageCount: 1, queuedAt: r.clock.now, expiresAt: r.clock.now + 600000,
    canonicalUser: { raw: '  USER\u0000' + n + '\r\n', strict: 'USER ' + n } });
  r.append = (n, text, extra = {}) => r.capture.ledger.appendObserved({
    origin: r.origin(n), recordId: r.origin(n).requestId, assistantText: text, ...extra
  });
  return r;
}

const checks = [];
const root = path.resolve(__dirname, '..');
const artifact = path.resolve(process.env.LIBRA_RECALL_TEST_DIST || path.join(root, 'dist/LIBRA World Manager Full.js'));
const artifactSha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');

async function fixture() {
  const r = await captureRuntime(undefined, { dist: artifact });
  r.ledger = r.capture.ledger;
  r.writes = [];
  r.hostWrites = 0;
  const set = r.storage.setItem;
  r.storage.setItem = async (key, value) => {
    r.writes.push({ key, value });
    return set(key, value);
  };
  for (const name of ['setChatToIndex', 'setCharacter', 'setCharacterToIndex']) {
    r.host[name] = async () => { r.hostWrites++; throw new Error('host persistence forbidden in ledger test'); };
  }
  r.host.nativeFetch = async () => { r.state.calls.push({ forbidden: true }); throw new Error('provider forbidden in ledger test'); };
  r.receipt = async (n, extra = {}) => {
    const result = await r.append(n, `Exact original ${n}: \r\n본문\u0000`, extra);
    assert.equal(result.ok, true, result.reason);
    r.writes.length = 0;
    return result;
  };
  return r;
}

async function check(name, run) {
  if (process.env.LIBRA_LEDGER_STATUS_FILTER && !new RegExp(process.env.LIBRA_LEDGER_STATUS_FILTER).test(name)) return;
  let r;
  try {
    r = await fixture();
    const detail = await run(r);
    assert.equal(r.state.calls.length, 0, 'no provider calls');
    assert.equal(r.hostWrites, 0, 'no host mirror writes');
    checks.push({ name, ok: true, detail });
    console.log('PASS ' + name);
  } catch (error) {
    checks.push({ name, ok: false, error: error.stack, observed: r?.observed,
      providerCalls: r?.state.calls.length, hostWrites: r?.hostWrites });
    console.error('FAIL ' + name + ': ' + error.message);
    process.exitCode = 1;
  }
}

async function assertRejectedWithoutWrite(r, handle, reason, patch = { status: 'committed', analysisStatus: 'done' }, options = {}) {
  const before = [...r.store];
  const result = await r.ledger.markStatus(handle, patch, options);
  r.observed = { ok: result.ok, verified: result.verified, reason: result.reason,
    sidecarWrites: r.writes.filter(row => row.key.endsWith('::status')).length };
  assert.equal(result.ok, false, 'invalid receipt must not authorize a verified lifecycle update');
  assert.equal(result.verified === true, false);
  if (Array.isArray(reason)) assert(reason.includes(result.reason), result.reason);
  else assert.equal(result.reason, reason);
  assert.equal(r.writes.length, 0, 'rejected transition must not write any receipt or sidecar');
  assert.deepEqual([...r.store], before, 'rejected transition preserves all physical bytes');
  return r.observed;
}

async function main() {
  await check('wrong recordId cannot complete or hide another capture', async r => {
    const receipt = await r.receipt(101);
    const wrong = { ...receipt, recordId: receipt.recordId + '-different-job' };
    assert.equal((await r.ledger.readRecord(wrong)).reason, 'raw_record_binding_invalid');
    const detail = await assertRejectedWithoutWrite(r, wrong, 'raw_record_binding_invalid');
    assert.equal((await r.ledger.listPending(receipt.scopeKey)).some(row => row.recordId === receipt.recordId), true);
    return detail;
  });

  for (const field of ['assistantText', 'userText']) await check(`corrupted ${field} cannot receive a verified completion sidecar`, async r => {
    const receipt = await r.receipt(102);
    const raw = JSON.parse(r.store.get(receipt.recordKey));
    raw[field] += ' CORRUPTED';
    r.store.set(receipt.recordKey, JSON.stringify(raw));
    assert.equal((await r.ledger.readRecord(receipt)).reason, 'raw_record_integrity_invalid');
    return assertRejectedWithoutWrite(r, receipt, 'raw_record_integrity_invalid');
  });

  await check('raw receipt transplanted to another record key cannot be completed', async r => {
    const a = await r.receipt(103), b = await r.receipt(104);
    r.store.set(a.recordKey, r.store.get(b.recordKey));
    assert.equal((await r.ledger.readRecord(a)).reason, 'raw_record_binding_invalid');
    return assertRejectedWithoutWrite(r, a, 'raw_record_binding_invalid');
  });

  await check('foreign scope handle remains rejected without a sidecar', async r => {
    const receipt = await r.receipt(105);
    const wrong = { ...receipt, scopeKey: receipt.scopeKey + '|foreign' };
    assert.equal((await r.ledger.readRecord(wrong)).reason, 'raw_record_binding_invalid');
    return assertRejectedWithoutWrite(r, wrong, ['raw_record_binding_invalid', 'record_scope_mismatch']);
  });

  await check('distinct branch chat scope cannot complete its parent receipt', async r => {
    const parent = await r.receipt(106);
    const branchScope = parent.scopeKey.replace(`::${r.chat.id}::`, `::${r.chat.id}-branch::`);
    assert.notEqual(branchScope, parent.scopeKey);
    const branch = await r.receipt(107, { scopeKey: branchScope, chatId: r.chat.id + '-branch' });
    const wrong = { recordKey: parent.recordKey, recordId: parent.recordId, scopeKey: branch.scopeKey };
    await assertRejectedWithoutWrite(r, wrong, ['raw_record_binding_invalid', 'record_scope_mismatch']);
    assert.equal((await r.ledger.listPending(parent.scopeKey)).length, 1);
    assert.equal((await r.ledger.listPending(branch.scopeKey)).length, 1);
  });

  await check('analysis claim still rejects a mismatched reset generation', async r => {
    const receipt = await r.receipt(108, { resetGeneration: 3 });
    assert.equal((await r.ledger.readRecord(receipt)).ok, true);
    return assertRejectedWithoutWrite(r, receipt, 'analysis_receipt_generation_changed', {
      analysisStatus: 'running', analysisStartedAt: r.clock.now, analysisRecoveryAttempt: 0
    }, { claimAnalysisAttempt: true, resetGeneration: 2, maxRecoveryAttempts: 1 });
  });

  await check('ordinary status patch cannot mutate immutable reset generation', async r => {
    const receipt = await r.receipt(109, { resetGeneration: 3 });
    return assertRejectedWithoutWrite(r, receipt, 'immutable_raw_receipt', {
      status: 'committed', analysisStatus: 'done', resetGeneration: 4
    });
  });

  await check('same-key queued wrong capture cannot hide a valid in-flight receipt', async r => {
    const receipt = await r.receipt(110);
    const rawBefore = r.store.get(receipt.recordKey), statusKey = receipt.recordKey + '::status';
    const set = r.storage.setItem;
    let release, entered, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    r.storage.setItem = async (key, value) => {
      if (key === statusKey && !held) { held = true; entered(); await gate; }
      return set(key, value);
    };
    const valid = r.ledger.markStatus(receipt, { analysisStatus: 'queued' });
    await started;
    let wrongSettled = false;
    const wrong = r.ledger.markStatus({ ...receipt, recordId: receipt.recordId + '-wrong' }, {
      status: 'committed', analysisStatus: 'done'
    }).then(value => { wrongSettled = true; return value; });
    try {
      await flush();
      assert.equal(wrongSettled, false, 'same-key wrong job waits for the held valid transition');
    } finally { release(); }
    assert.equal((await valid).ok, true);
    const bad = await wrong;
    r.observed = { ok: bad.ok, verified: bad.verified, reason: bad.reason,
      sidecarWrites: r.writes.filter(row => row.key === statusKey).length };
    assert.equal(bad.ok, false, 'queued wrong capture must be checked after obtaining the key lock');
    assert.equal(bad.reason, 'raw_record_binding_invalid');
    assert.equal(r.writes.filter(row => row.key === statusKey).length, 1, 'only the valid queued transition writes');
    assert.equal((await r.ledger.readRecord(receipt)).record.analysisStatus, 'queued');
    assert.equal((await r.ledger.listPending(receipt.scopeKey)).some(row => row.recordId === receipt.recordId), true);
    assert.equal(r.store.get(receipt.recordKey), rawBefore);
    return r.observed;
  });

  await check('unavailable physical raw read cannot authorize completion', async r => {
    const receipt = await r.receipt(111);
    const get = r.storage.getItem;
    r.storage.getItem = async key => {
      if (key === receipt.recordKey) throw new Error('fixture raw read unavailable');
      return get(key);
    };
    const checked = await r.ledger.readRecord(receipt);
    assert.equal(checked.ok, false);
    return assertRejectedWithoutWrite(r, receipt, checked.reason);
  });

  for (const nextStatus of ['replaying', 'running', 'done']) await check(`stale ${nextStatus} update cannot replace a terminal uncertain analysis receipt`, async r => {
    const receipt = await r.receipt(114);
    const staleSnapshot = await r.ledger.readRecord(receipt);
    assert.equal(staleSnapshot.record.analysisStatus, 'pending');
    const terminal = await r.ledger.markStatus(receipt, { status: 'committed', analysisStatus: 'terminal',
      terminalReason: 'canonical_persist_unverified', canonicalVerified: false,
      analysisError: 'canonical_persist_unverified', analysisFinishedAt: r.clock.now });
    assert.equal(terminal.ok, true);
    const before = [...r.store];
    r.writes.length = 0;
    const late = await r.ledger.markStatus(receipt, { analysisStatus: nextStatus,
      canonicalVerified: true, terminalReason: '', analysisError: '', analysisRecoveryAttempt: 1 });
    r.observed = { ok: late.ok, unchanged: late.unchanged,
      analysisStatus: late.record?.analysisStatus, canonicalVerified: late.record?.canonicalVerified,
      sidecarWrites: r.writes.length };
    assert.equal(late.ok, true);
    assert.equal(late.unchanged, true, 'terminal uncertainty is monotonic even for an older ordinary replay/completion');
    assert.equal(late.record.analysisStatus, 'terminal');
    assert.equal(late.record.canonicalVerified, false);
    assert.equal(late.record.terminalReason, 'canonical_persist_unverified');
    assert.equal(r.writes.length, 0);
    assert.deepEqual([...r.store], before, 'stale transition cannot erase uncertainty metadata');
    assert.equal((await r.ledger.listPending(receipt.scopeKey)).length, 0);
    return r.observed;
  });

  await check('same-key replay queued behind terminal uncertainty cannot revive it or block another receipt', async r => {
    const receipt = await r.receipt(115), unrelated = await r.receipt(116);
    const rawBefore = r.store.get(receipt.recordKey), statusKey = receipt.recordKey + '::status';
    const staleSnapshot = await r.ledger.readRecord(receipt);
    assert.equal(staleSnapshot.record.analysisStatus, 'pending');
    const set = r.storage.setItem;
    let release, entered, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    r.storage.setItem = async (key, value) => {
      if (key === statusKey && !held) { held = true; entered(); await gate; }
      return set(key, value);
    };
    const terminal = r.ledger.markStatus(receipt, { status: 'committed', analysisStatus: 'terminal',
      terminalReason: 'canonical_persist_unverified', canonicalVerified: false, analysisFinishedAt: r.clock.now });
    await started;
    let replaySettled = false;
    const replay = r.ledger.markStatus(receipt, { analysisStatus: 'replaying', replayStartedAt: r.clock.now })
      .then(value => { replaySettled = true; return value; });
    try {
      assert.equal((await r.ledger.markStatus(unrelated, { status: 'committed', analysisStatus: 'done' })).ok, true,
        'a different record key progresses while this terminal transition is held');
      await flush();
      assert.equal(replaySettled, false, 'stale same-key replay waits for terminal publication');
    } finally { release(); }
    assert.equal((await terminal).ok, true);
    const late = await replay;
    r.observed = { ok: late.ok, unchanged: late.unchanged, analysisStatus: late.record?.analysisStatus,
      sidecarWrites: r.writes.filter(row => row.key === statusKey).length };
    assert.equal(late.ok, true);
    assert.equal(late.unchanged, true, 'terminal guard is rechecked after acquiring the record lock');
    assert.equal(late.record.analysisStatus, 'terminal');
    assert.equal(late.record.canonicalVerified, false);
    assert.equal(late.record.terminalReason, 'canonical_persist_unverified');
    assert.equal(r.writes.filter(row => row.key === statusKey).length, 1);
    assert.equal((await r.ledger.readRecord(unrelated)).record.analysisStatus, 'done');
    assert.equal((await r.ledger.listPending(receipt.scopeKey)).length, 0);
    assert.equal(r.store.get(receipt.recordKey), rawBefore);
    return r.observed;
  });

  await check('valid completion and duplicate capture retain immutable raw bytes', async r => {
    const receipt = await r.receipt(112);
    const rawBefore = r.store.get(receipt.recordKey);
    const completed = await r.ledger.markStatus(receipt, { status: 'committed', analysisStatus: 'done', turn: 12 });
    assert.equal(completed.ok, true); assert.equal(completed.verified, true);
    assert.equal((await r.ledger.readRecord(receipt)).record.analysisStatus, 'done');
    assert.equal((await r.ledger.listPending(receipt.scopeKey)).length, 0);
    const statusBefore = r.store.get(receipt.recordKey + '::status');
    const duplicate = await r.append(112, 'Exact original 112: \r\n본문\u0000');
    assert.equal(duplicate.ok, true); assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.record.analysisStatus, 'done');
    assert.equal(r.store.get(receipt.recordKey), rawBefore);
    assert.equal(r.store.get(receipt.recordKey + '::status'), statusBefore);
    assert(r.writes.every(row => row.key === receipt.recordKey + '::status'), 'completion writes sidecar only');
  });

  await check('valid claims preserve generation attempt and completion transition rules', async r => {
    const receipt = await r.receipt(113, { resetGeneration: 3 });
    const rawBefore = r.store.get(receipt.recordKey);
    const options = { claimAnalysisAttempt: true, resetGeneration: 3, maxRecoveryAttempts: 1 };
    const patch = { analysisStatus: 'running', analysisStartedAt: r.clock.now, analysisRecoveryAttempt: 0 };
    const first = await r.ledger.markStatus(receipt, patch, options);
    assert.equal(first.ok, true); assert.equal(first.verified, true); assert.notEqual(first.unchanged, true);
    const duplicate = await r.ledger.markStatus(receipt, patch, options);
    assert.equal(duplicate.ok, true); assert.equal(duplicate.unchanged, true);
    assert.equal(duplicate.reason, 'analysis_attempt_already_reserved');
    const recovery = await r.ledger.markStatus(receipt, { ...patch, analysisRecoveryAttempt: 1 }, options);
    assert.equal(recovery.ok, true); assert.notEqual(recovery.unchanged, true);
    const stale = await r.ledger.markStatus(receipt, { analysisStatus: 'failed', analysisRecoveryAttempt: 0 });
    assert.equal(stale.ok, true); assert.equal(stale.unchanged, true);
    assert.equal(stale.reason, 'analysis_attempt_superseded');
    const completion = await r.ledger.markStatus(receipt, { status: 'committed', analysisStatus: 'done', analysisRecoveryAttempt: 1 });
    assert.equal(completion.ok, true);
    const late = await r.ledger.markStatus(receipt, { analysisStatus: 'queued', analysisRecoveryAttempt: 1 });
    assert.equal(late.ok, true); assert.equal(late.unchanged, true);
    assert.equal((await r.ledger.readRecord(receipt)).record.analysisStatus, 'done');
    assert.equal(r.store.get(receipt.recordKey), rawBefore);
    assert(r.writes.every(row => row.key === receipt.recordKey + '::status'), 'claim lifecycle never overwrites source');
  });

  const summary = { artifact, artifactSha256, exposureEvidence, passed: checks.filter(row => row.ok).length,
    failed: checks.filter(row => !row.ok).length, realModelCalls: 0, externalCalls: 0,
    verificationScope: 'In-process raw receipt lifecycle; no ordinary host-mirror path',
    resetScope: 'Existing analysis-claim generation and immutable-patch checks only; ordinary handle reset equality is not implemented or asserted',
    checks };
  if (process.env.LIBRA_LEDGER_STATUS_PHASE) {
    const phase = process.env.LIBRA_LEDGER_STATUS_PHASE;
    assert(/^[a-z0-9-]+$/.test(phase), 'safe evidence phase');
    const output = path.join(root, 'verification/maintenance-receipt');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, `ledger-${phase}.json`), JSON.stringify(summary, null, 2) + '\n');
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
