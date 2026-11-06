'use strict';
// Production Micro value typing extracted from LIBRA.js; shared utilities are stubbed.
// One turn may add a place description, the current momentum or a continuity lock;
// story structure across turns stays Canonical.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
const part = (from, to) => { const i = source.indexOf(from), j = source.indexOf(to, i + from.length); assert.ok(i >= 0 && j > i, from); return source.slice(i, j); };
const key = x => String(x || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const context = vm.createContext({
  asArray: x => Array.isArray(x) ? x : [], asObject: x => x && typeof x === 'object' && !Array.isArray(x) ? x : {},
  clone: x => JSON.parse(JSON.stringify(x)), string: x => typeof x === 'string' ? x : '', compact: (x, n) => String(x ?? '').slice(0, n),
  statePipelineIdentityKey: key, stableHash: x => String(x).length.toString(16), statePipelineRiskFieldKey: key,
  canonicalEntityNameBoundToEvidence: (name, quote) => String(quote).includes(name), unifiedProfileItemIdentity: () => '',
  MICRO_WORLD_REFERENCE_FIELDS: { holderRef: ['person'], containerRef: ['world'], parentRef: ['world'], ownerRef: ['person', 'world'], managerRef: ['person', 'world'] },
  MICRO_STRING_COLLECTION_FIELDS: new Set(['appearance', 'background', 'personality', 'speech', 'habits', 'abilities', 'knowledge'])
});
vm.runInContext([
  part('const microStateItemIdentity =', 'const microStateValueForField ='),
  part('const microStateValueForField =', 'const statePipelineDomainOpenForMicro ='),
  'Object.assign(globalThis,{microStateItemIdentity,microStateMergeCollection,microStateValueForField});'
].join('\n'), context);
const plain = x => JSON.parse(JSON.stringify(x));
const quote = '폐공장은 천장이 높다. 경찰에 신고하면 세아가 죽는다고 했다.';
const typed = (domain, field, value) => plain(context.microStateValueForField({ domain, field, value, quote, subjectId: 'ce_world_x', resolve: () => null }));

const description = typed('world', 'description', '폐공장은 천장이 높다');
assert.deepEqual(description, { ok: true, value: '폐공장은 천장이 높다', additive: true }, 'a place description is one added item');
assert.equal(typed('world', 'description', '창문이 없다').reason, 'state_value_not_source_bound', 'description must be quoted');
assert.deepEqual(plain(context.microStateMergeCollection('description', 'ce_world_x', ['기존 설명'], ['폐공장은 천장이 높다'])), ['기존 설명', '폐공장은 천장이 높다'], 'earlier description is kept');

assert.deepEqual(typed('narrative', 'momentum', '경찰에 신고하면 세아가 죽는다고 했다'), { ok: true, value: '경찰에 신고하면 세아가 죽는다고 했다', additive: false }, 'momentum is one quoted sentence');

const lock = typed('narrative', 'locks', { title: '신고 금지', summary: '경찰에 신고하면 세아가 죽는다고 했다', status: 'active' });
assert.equal(lock.ok, true); assert.equal(lock.additive, true);
assert.equal(lock.value.title, '신고 금지'); assert.match(lock.value.id, /^lock_/);
assert.equal(typed('narrative', 'locks', { title: '신고 금지', summary: '없는 문장', status: 'active' }).reason, 'state_value_not_source_bound');
assert.equal(typed('narrative', 'locks', { title: '신고 금지', summary: '경찰에 신고하면 세아가 죽는다고 했다', status: 'maybe' }).reason, 'state_value_shape_invalid');
const released = typed('narrative', 'locks', { title: '신고 금지', summary: '경찰에 신고하면 세아가 죽는다고 했다', status: 'released' }).value;
assert.deepEqual(plain(context.microStateMergeCollection('locks', '', [lock.value], [released])).map(r => r.status), ['released'], 'the same title releases the lock instead of adding a second one');

// Admission keeps cross-turn narrative structure Canonical-only.
const admission = part("if (domain === 'narrative' && field === 'threads') return pending('narrative_thread_canonical_only');", "const clearing = intent.operation === 'clear';");
assert.match(admission, /if \(domain === 'narrative' && !\['momentum', 'locks'\]\.includes\(field\)\) return pending\('narrative_field_canonical_only'\);/);
assert.match(admission, /!\(domain === 'narrative' && field === 'locks'\) && MICRO_STATE_RECORD_FIELDS/);
console.log('PASS Micro adds place description, momentum and continuity locks; other narrative fields stay Canonical');
