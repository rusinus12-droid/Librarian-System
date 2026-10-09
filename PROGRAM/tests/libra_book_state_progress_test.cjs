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
const renderer = source.slice(end, source.indexOf('const bookProjectionStateValue =', end));
// Still true, and the reasons this test exists: a retry must be a read-only recovery for THIS scope,
// and the control must never kick off analysis or a cold start.
assert.match(renderer, /force: true, unifiedOnly: true/);
assert.match(renderer, /context\.scope\?\.scopeKey !== progress\.scopeKey/);
assert.doesNotMatch(renderer, /startCanonical|startSelectedCanonical|coldStart|manualScan/);
// §32.3 replaced the always-on card with a header button. Both facts are asserted against the CURRENT
// structure: the detail builder exists and is fed the current page's progress, and the button is built
// for `Gui.bookPage`. Asserting the old `buildBookStateProgress(...)` call would demand a deleted
// function and is what made this suite fail on extraction before it checked anything.
assert.ok(source.includes('const buildBookStateDetail ='), 'the status detail builder must exist');
assert.ok(source.includes('const buildBookStateButton ='), 'the status button builder must exist');
// The control is built for the page being shown, and the detail consumes that same progress object.
assert.match(source, /buildBookStateButton\(options\.pageId \|\| Gui\.bookPage\)/,
  'the header button must be built for the CURRENT page');
assert.match(source, /buildBookStateDetail\(progress, message\)/,
  'the detail must consume the same progress the control was built from');
assert.match(source, /const progress = bookStateProgress\(page, LibraMemoryCore\.peekSnapshot\(\) \|\| \{\}, LibraMemoryCore\.state\.canonicalJob\)/,
  'progress must be derived from the read-only snapshot for the displayed page');
console.log('PASS: reader state progress, per-domain cursors, loading, pending, failure, scope and local-only recovery');
