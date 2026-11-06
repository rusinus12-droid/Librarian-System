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
  part('const microStateFieldAdmissionReason =', 'const microStateItemIdentity ='),
  part('const microStateItemIdentity =', 'const microStateValueForField ='),
  part('const microStateValueForField =', 'const statePipelineDomainOpenForMicro ='),
  'Object.assign(globalThis,{microStateItemIdentity,microStateMergeCollection,microStateValueForField,microStateFieldAdmissionReason});'
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

const ruleQuote = '도서관은 정숙 구역이다. 공연실은 허가된 공연 중 소음을 허용한다.';
const places = { 도서관: { id: 'library', kind: 'location' }, 공연실: { id: 'hall', kind: 'location' } };
const rule = value => plain(context.microStateValueForField({ domain: 'world', field: 'rule', value,
  quote: ruleQuote, subjectId: 'library', resolve: name => places[name] || null }));
assert.deepEqual(rule({ text: '정숙 구역', scopeName: '도서관', exceptions: [{ locationName: '공연실', condition: '허가된 공연 중', effect: '소음을 허용한다' }] }),
  { ok: true, value: { text: '정숙 구역', scopeRef: 'library', exceptions: [{ locationRef: 'hall', condition: '허가된 공연 중', effect: '소음을 허용한다' }] }, additive: false },
  'a Micro rule keeps its scope and exception instead of flattening them');
assert.equal(rule({ text: '정숙 구역', scopeName: '존재하지 않는 장소' }).reason, 'state_value_not_source_bound');
assert.equal(rule({ text: '정숙 구역', exceptions: [{ locationName: '공연실', condition: '허가된 공연 중', effect: '무조건 허용' }] }).reason, 'state_value_not_source_bound');
assert.equal(rule({ text: '정숙 구역', scopeRef: 'untrusted-id' }).reason, 'state_value_shape_invalid');
assert.equal(rule({ text: '정숙 구역', exceptions: {} }).reason, 'state_value_shape_invalid');
assert.deepEqual(rule('정숙 구역').value, { text: '정숙 구역', scopeRef: 'library', exceptions: [] }, 'legacy scalar rules stay readable');
const scoped = value => context.microStateValueForField({domain: 'character', field: 'boundaries', value,
  quote: '민아는 지호에게 내 일기를 읽지 마라고 말했다.', subjectId: 'mina', resolve: name => ({id: name, type: 'person'})});
assert.equal(scoped({content: '내 일기를 읽지 마', topic: '일기', kind: 'boundary', scope: {targetName: '라온'}}).reason, 'state_value_not_source_bound', 'a known but uncited boundary target is still unbound');
assert.equal(scoped({content: '내 일기를 읽지 마', topic: '일기', kind: 'boundary', scope: {targetName: '지호', when: '영원히'}}).reason, 'state_value_not_source_bound', 'boundary scope must not invent a time axis');
assert.equal(context.microStateValueForField({domain: 'world', field: 'ownerRef', value: '도서관', quote: '도서관', subjectId: 'key',
  resolve: () => ({id: 'library', type: 'world', kind: 'location'})}).reason, 'registry_reference_unresolved', 'a location cannot become an owner organization');

// Admission keeps cross-turn narrative structure Canonical-only.
vm.runInContext('globalThis.MICRO_STATE_RECORD_FIELDS = new Set(["primaryarcid", "locks"]);', context);
const admit = context.microStateFieldAdmissionReason;
for (const field of ['momentum', 'locks', 'summary']) assert.equal(admit('narrative', field), '', field + ' retains its Micro route');
for (const field of ['arcs', 'resolvedArcs', 'turningPoints', 'motifs', 'closedThreads', 'events']) assert.equal(admit('narrative', field), 'narrative_field_canonical_only', field + ' requires cross-turn evidence');
assert.equal(admit('narrative', 'threads'), 'narrative_thread_canonical_only');
assert.equal(admit('narrative', 'primaryArcId'), 'state_field_names_record');
// A short past-tense predicate is a moment, not a trait; a named trait still passes.
const speechQuote = '그의 목소리가 차가워졌다. 세희는 조용하지만 단단한 목소리로 말한다.';
const speech = value => plain(context.microStateValueForField({ domain: 'character', field: 'speech', value, quote: speechQuote, subjectId: 'ce_person_x', resolve: () => null }));
assert.equal(speech('차가워졌다').reason, 'state_value_momentary_fragment');
assert.equal(speech('조용하지만 단단한 목소리로 말한다').ok, true);
console.log('PASS Micro adds place description, momentum and continuity locks; other narrative fields stay Canonical');
