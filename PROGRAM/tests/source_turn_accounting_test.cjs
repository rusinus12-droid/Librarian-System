'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { test } = require('node:test');
const os = require('node:os');
const { synchronize } = require('../tools/sync_source_turn_accounting.cjs');
const source = fs.readFileSync(path.join(__dirname, '../sdk/MemorySuiteSourceTurnAccounting.source.js'), 'utf8');
const count = vm.runInNewContext(source + '\ncountMemorySuiteSourceTurns');
const plain = value => JSON.parse(JSON.stringify(value));
const contributor = (overrides = {}) => ({ scope: 'scope-a', generation: 'revision-a', originalTurnId: 'turn-a',
  verified: true, current: true, range: { start: 0, end: 5 }, text: 'hello', ...overrides });
const unit = (overrides = {}) => ({ lane: 'optional', emittedText: 'hello', attributionComplete: true,
  contributors: [contributor()], ...overrides });
const run = units => plain(count({ owner: 'test', units }));
test('duplicate chunks and roles count one original turn, with deterministic JSON and no mutation', () => {
  const units = [unit(), unit({ contributors: [contributor({ role: 'assistant' }), contributor({ role: 'user' })] })];
  const original = JSON.stringify(units), a = run(units), b = run(units.slice().reverse());
  assert.equal(a.knownUniqueOriginalTurns, 1); assert.equal(a.completeUniqueOriginalTurns, 1);
  assert.equal(a.status, 'complete'); assert.deepEqual(a, b); assert.equal(JSON.stringify(units), original);
  assert.equal(JSON.stringify(a).includes('hello'), false);
});
test('same ordinal and aliases stay distinct across scopes, source generations and owner IDs', () => {
  const a = run([unit(), unit({contributors:[contributor({scope:'scope-b'})]}), unit({contributors:[contributor({generation:'revision-b'})]})]);
  assert.equal(a.knownUniqueOriginalTurns, 3);
  assert.notDeepEqual(run([unit()]).identities, plain(count({owner:'other', units:[unit()]})).identities);
});
test('merged records count only verified exact emitted contributors and retain partial unknowns', () => {
  const a = run([unit({emittedText:'hello world',contributors:[contributor(),contributor({originalTurnId:'turn-b',range:{start:6,end:11},text:'world'})]})]);
  assert.equal(a.completeUniqueOriginalTurns, 2);
  const b = run([unit(), unit({ attributionComplete:false, contributors:[contributor({originalTurnId:'turn-b'})] })]);
  assert.equal(b.knownUniqueOriginalTurns,2); assert.equal(b.completeUniqueOriginalTurns,null); assert.equal(b.status,'partial');
  assert.equal(b.unresolvedUnits,1);
});
test('trimmed ranges, changed bytes, missing proof and stale/deleted/rollback contributors are unresolved', () => {
  for (const change of [ {range:{start:0,end:6}}, {range:{start:-1,end:4}}, {range:{start:0,end:2.5}},
    {range:{start:5,end:5}}, {text:'HELLO'}, {verified:false}, {current:false}, {deleted:true}, {rolledBack:true},
    {generation:''}, {scope:''}, {originalTurnId:''}, {range:null} ]) {
    const result = run([unit({contributors:[contributor(change)]})]);
    assert.equal(result.knownUniqueOriginalTurns,0,JSON.stringify(change));
    assert.equal(result.completeUniqueOriginalTurns,null); assert.equal(result.unresolvedUnits,1);
  }
  assert.equal(run([unit({emittedText:'',contributors:[contributor({current:false})]})]).completeUniqueOriginalTurns,0);
});
test('UTF-16 offsets are exact and unknown original mapping never becomes zero', () => {
  const known = run([unit({emittedText:'a😀b',contributors:[contributor({range:{start:1,end:3},text:'😀'})]})]);
  assert.equal(known.completeUniqueOriginalTurns,1);
  const unknown = run([unit({contributors:[]})]);
  assert.equal(unknown.status,'unknown'); assert.equal(unknown.completeUniqueOriginalTurns,null);
});
test('core and optional overlap is reported without double counting or assigning quotas', () => {
  const result = run([unit({lane:'core'}),unit(),unit({lane:'long',contributors:[contributor({originalTurnId:'turn-b'})]})]);
  assert.equal(result.knownUniqueOriginalTurns,2); assert.equal(result.overlap.coreOptionalKnownOriginalTurns,1);
  assert.equal(result.overlap.multipleLanesKnownOriginalTurns,1);
  assert.deepEqual(result.lanes.map(row=>[row.lane,row.knownUniqueOriginalTurns]),[['core',1],['long',1],['optional',1]]);
  assert.equal('quotaFulfilled' in result,false);
});
test('prototype-like lane and identity keys are ordinary data; invalid arrays cannot become complete zero', () => {
  const result = run([unit({lane:'__proto__',contributors:[contributor({originalTurnId:'constructor'})]}),unit({lane:'constructor'})]);
  assert.equal(result.knownUniqueOriginalTurns,2); assert.deepEqual(result.lanes.map(row=>row.lane),['__proto__','constructor']);
  for (const units of [null, {}, [null], Array(1)]) {
    const output = plain(count({owner:'test',units})); assert.equal(output.completeUniqueOriginalTurns,null);
  }
  assert.equal(run([]).completeUniqueOriginalTurns,0);
});
test('embedding accounting preserves the complete leading host metadata and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-turn-header-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'plugins'));
  fs.mkdirSync(path.join(root, 'sdk'));
  fs.writeFileSync(path.join(root, 'sdk/MemorySuiteSourceTurnAccounting.source.js'), source);
  const header = '//@name fixture\n//@api 3.0\n//@version 0.0.1\n//@allowed-ipc peer\n//@arg enabled string true|false\n//@update-url https://offline.invalid/plugin.js\n';
  const files = ['LIBRA.js', 'HAYAKU_Locator_Continuity.js', 'Flashback_Memory.js'];
  for (const file of files) fs.writeFileSync(path.join(root, 'plugins', file), header + 'globalThis.result = countMemorySuiteSourceTurns({owner:"fixture",units:[]});\n');
  assert.equal(synchronize({ root }), 3);
  const embedded = files.map(file => fs.readFileSync(path.join(root, 'plugins', file), 'utf8'));
  for (const output of embedded) {
    assert.ok(output.startsWith(header), 'all metadata remains before the inserted function');
    const context = {};
    vm.runInNewContext(output, context);
    assert.equal(context.result.completeUniqueOriginalTurns, 0);
  }
  assert.equal(synchronize({ root, check: true }), 3);
  synchronize({ root });
  assert.deepEqual(files.map(file => fs.readFileSync(path.join(root, 'plugins', file), 'utf8')), embedded);
});
