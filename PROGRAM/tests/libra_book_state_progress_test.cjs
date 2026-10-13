'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const start = source.indexOf('const bookStateProgress =');
const end = source.indexOf('const bookStateVerdict =', start);
assert.ok(start > 0, 'the extraction boundary "const bookStateProgress =" must exist in LIBRA.js');
// §32.3 replaced buildBookStateProgress with buildBookStateDetail/buildBookStateButton, so the end
// boundary now stops at bookStateVerdict. If this ever returns -1 the assertions below would never
// run, which is exactly how this suite failed silently before.
assert.ok(end > start, 'the extraction end boundary "const bookStateVerdict =" must exist after bookStateProgress');
const classify = vm.runInNewContext(source.slice(start, end) + '\nbookStateProgress');
const snapshot = (rows, endTurn = 10) => ({ scope: { scopeKey: 'chat-a' }, manifest: { memories: {
  1: { status: 'committed', turnRange: { end: endTurn } }
} }, continuityState: { throughTurn: 10, domainStatus: rows } });
const ready = turn => ({ status: 'ready', throughTurn: turn });
assert.equal(classify('desk', {}), null);
assert.equal(classify('world', {}).state, 'loading');
assert.doesNotMatch(classify('world', {}).label, /T0/);
assert.equal(classify('world', {error:'storage unavailable'}).state, 'unavailable');
assert.equal(classify('world', {scope:{scopeKey:'a'},manifest:{memories:{}}}).state, 'empty');
assert.equal(classify('world', snapshot({world:ready(10)})).state, 'ready');
assert.equal(classify('people', snapshot({characters:ready(10),relationships:ready(5)})).label, '기억 저장 완료 · T10까지');
assert.match(classify('people', snapshot({characters:ready(10),relationships:ready(5)})).detail, /관계: T5/);
assert.equal(classify('story', snapshot({narrative:ready(5)})).state, 'pending');
assert.match(classify('world', snapshot({world:{status:'ready'}})).label, /미확인/);
assert.match(classify('people', snapshot({characters:ready(10)})).label, /미확인/);
const pending = snapshot({world:{status:'not_updated',throughTurn:5,reason:'unified_bindings_pending'}});
assert.equal(classify('world', pending).state, 'partial');
assert.equal(classify('world', pending).retry, true);
assert.equal(classify('world', pending, {scopeKey:'chat-a',state:'running'}).retry, false);
assert.equal(classify('world', pending, {scopeKey:'chat-b',state:'running'}).retry, true);
assert.equal(classify('world', snapshot({world:{status:'not_updated',throughTurn:5,reason:'storage_readback_failed'}})).state, 'failed');
const legacy = snapshot({world:ready(10)});
legacy.continuityState.unifiedCoverage = {legacyCount:1};
assert.equal(classify('world', legacy).state, 'partial');
assert.equal(classify('world', legacy).retry, false, 'legacy-only limitation must not offer an ineffective retry');
const failedCommit = snapshot({world:ready(5)});
failedCommit.manifest.memories[1].runId = 'run-new';
failedCommit.runs = [{runId:'run-new',stateTracking:{status:'failed_open',reason:'readback_failed'}}];
assert.equal(classify('world', failedCommit).state, 'failed');
failedCommit.continuityState.domainStatus.world = ready(10);
assert.equal(classify('world', failedCommit).state, 'ready', 'an old failure must not override a recovered domain');
// The approved readonly status dialog replaces the paper header detail wrapper.
// Keep every classifier assertion above and check the new actual refresh owner.
const approved=require('./helpers/libra_approved_gui_contract.cjs');
const renderer=approved.extract(source,'openApprovedStateDialog');
assert.match(renderer,/LibraMemoryCore\.peekSnapshot\(\)/);
assert.match(renderer,/canonicalReaderBindingKey\(binding\)!==canonicalReaderBindingKey\(canonicalReaderBinding\(\)\)/,'readonly refresh stays on the captured scope');
assert.match(renderer,/refreshGuiSnapshot\(false\)/,'explicit refresh delegates to actual snapshot readback');
assert.doesNotMatch(renderer,/startCanonical|startSelectedCanonical|coldStart|manualScan/,'status refresh cannot launch analysis');
assert.match(renderer,/LIBRA_APPROVED_STATE_DIALOG_HTML/);
assert.match(renderer,/pipelineStatus==='partial'/);
assert.match(renderer,/Number\(row\.turnRange\?\.end\|\|0\)>Number\(view\.throughTurn\|\|0\)/,'awaiting segments remain separate from saved segments');
const deskRoute=approved.extract(source,'buildApprovedMockupDesk');
assert.match(deskRoute,/openApprovedStateDialog\(\)/,'the desk opens the actual readonly status owner');
assert.match(approved.extract(source,'buildWorldManagerDiagnosticsPanel'),/buildWorldManagerHistoryCorrectionsPanel/,'per-domain detailed state remains available through diagnostics');
console.log('PASS: reader state progress, domain cursors, loading/pending/failure, scope and readonly approved status');
