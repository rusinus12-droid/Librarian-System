'use strict';
// People on lens notes: one lens with trackSubject records whose note it is for several people in
// one call. A name must be written in the analyzed span (stored in the source's wording); "user" and
// "char" name the first-person speaker of a cited turn; an unverifiable name is dropped and the note
// kept as "인물 불명". People cards group names at read time only, and the fields survive handoff,
// native copy and portable export/restore.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { lensFixture } = require('./fixtures/libra_lens_handoff_fixture.cjs');

const plain = value => JSON.parse(JSON.stringify(value));
const batch = [
  { turn: 1, user: { text: '민아는 아침부터 머리가 아프다고 했다.' }, assistant: { text: '지호는 열이 38도까지 올랐다. 의사가 김 민아 씨에게 약을 건넸다.' } },
  { turn: 2, user: { text: '나 오늘 너무 피곤해.' }, assistant: { text: '나는 어젯밤 한숨도 못 잤어. 그녀는 창밖을 보았다.' } }
];
const PEOPLE_LENS = { evidenceMode: 'interpretive', trackSubject: true };
const note = extra => ({ label: '증상', text: '두통을 호소했다.', refs: ['t1-u'], basis: '본인이 말함', ...extra });

test('gate and prompt through the real plugin', async () => {
  const f = await lensFixture();
  try {
    const api = f.api;
    const evaluate = (items, lens = PEOPLE_LENS, subjects = { charName: '세린' }) => plain(api.evaluateLensCandidateItems({ items }, lens, batch, subjects));

    const named = evaluate([note({ who: ['민아'], whoRef: 't1-u' })]);
    assert.deepEqual(named.acceptedItems[0].who, [{ name: '민아', ref: 't1-u', role: 'named' }]);
    assert.equal(named.acceptedItems[0].whoIssue, '');

    const elsewhere = evaluate([note({ text: '열이 났다.', refs: ['t1-a'], who: ['지호'] })]);
    assert.deepEqual(elsewhere.acceptedItems[0].who, [{ name: '지호', ref: 't1-a', role: 'named' }], 'the name may be found in any turn of the span');

    const spacing = evaluate([note({ who: ['김민아'] })]);
    assert.equal(spacing.acceptedItems[0].who[0].name, '김 민아', 'a whitespace variant stores the source wording');

    const twoPeople = evaluate([note({ text: '열이 났다.', refs: ['t1-a'], who: ['지호'] }), note({ text: '열이 났다.', refs: ['t1-a'], who: ['민아'] })]);
    assert.equal(twoPeople.acceptedItems.length, 2, 'same wording about different people stays two notes');
    assert.notEqual(twoPeople.acceptedItems[0].itemId, twoPeople.acceptedItems[1].itemId);
    const duplicate = evaluate([note({ who: ['민아'] }), note({ who: ['민아'] })]);
    assert.equal(duplicate.acceptedItems.length, 1, 'the same note about the same person is still a duplicate');

    const shared = evaluate([note({ text: '둘 다 몸이 안 좋았다.', refs: ['t1-u', 't1-a'], who: '민아, 지호' })]);
    assert.deepEqual(shared.acceptedItems[0].who.map(person => person.name), ['민아', '지호'], 'several names for one shared fact (comma string accepted)');
    const many = evaluate([note({ who: ['민아', '지호', '김민아', 'user', 'char', '준호'] , refs: ['t1-u', 't2-u', 't2-a'] })]);
    assert.ok(many.acceptedItems[0].who.length <= 4, 'at most four people per note');

    const invented = evaluate([note({ who: ['수진'] })]);
    assert.equal(invented.acceptedItems.length, 1, 'a note with an unverified name is kept');
    assert.deepEqual(invented.acceptedItems[0].who, []);
    assert.equal(invented.acceptedItems[0].whoIssue, 'not_in_source');
    assert.ok(!JSON.stringify(invented.acceptedItems[0]).includes('수진'), 'the dropped name is not kept');

    for (const pronoun of ['그녀', '나', '모두', 'she']) {
      const result = evaluate([note({ refs: ['t2-a'], text: '창밖을 보았다.', who: [pronoun] })]);
      assert.deepEqual(result.acceptedItems[0].who, [], `${pronoun} is not a name even though it is in the text`);
      assert.equal(result.acceptedItems[0].whoIssue, 'not_in_source');
    }
    const partial = evaluate([note({ who: ['민아', '수진'] })]);
    assert.deepEqual(partial.acceptedItems[0].who.map(person => person.name), ['민아']);
    assert.equal(partial.acceptedItems[0].whoIssue, 'not_in_source', 'a partly dropped list is flagged');

    const user = evaluate([note({ text: '피곤하다고 했다.', refs: ['t2-u'], who: ['user'] })]);
    assert.deepEqual(user.acceptedItems[0].who, [{ name: '사용자', ref: 't2-u', role: 'user' }], 'the user\'s own first person');
    const userWithoutTurn = evaluate([note({ text: '열이 났다.', refs: ['t1-a'], who: ['user'] })]);
    assert.deepEqual(userWithoutTurn.acceptedItems[0].who, [], '"user" needs a cited user turn');
    const character = evaluate([note({ text: '잠을 못 잤다.', refs: ['t2-a'], who: ['char'] })]);
    assert.deepEqual(character.acceptedItems[0].who, [{ name: '세린', ref: 't2-a', role: 'char' }]);
    const characterByName = evaluate([note({ text: '잠을 못 잤다.', refs: ['t2-a'], who: ['세린'] })]);
    assert.deepEqual(characterByName.acceptedItems[0].who, [{ name: '세린', ref: 't2-a', role: 'char' }], 'the character\'s own name maps to its first-person turn');
    const outside = evaluate([note({ who: ['민아'], whoRef: 't9-u', refs: ['t2-u'], text: '피곤하다.' })]);
    assert.deepEqual(outside.acceptedItems[0].who, [{ name: '민아', ref: 't1-u', role: 'named' }], 'an out-of-range whoRef is ignored, never read');

    const counts = evaluate([note({ who: ['민아'] }), note({ text: '두 번째', who: ['수진'] }), note({ text: '세 번째', refs: ['t1-a'] })]).counts;
    assert.deepEqual({ named: counts.subjectNamed, unknown: counts.subjectUnknown, dropped: counts.subjectDropped }, { named: 1, unknown: 2, dropped: 1 });
    assert.equal(counts.subjectNamed + counts.subjectUnknown, counts.quoted + counts.interpreted, 'named + unknown = accepted');

    const off = evaluate([note({ who: ['민아'] })], { evidenceMode: 'interpretive' });
    assert.equal('who' in off.acceptedItems[0], false, 'a non-tracking lens stores no people');
    assert.equal(off.counts.subjectUnknown, undefined);
    assert.equal('who' in off.acceptedItems[0].extra, false, 'a model-given who never leaks into extra values');

    const both = evaluate([note({ who: ['민아'], when: '아침' })], { evidenceMode: 'interpretive', trackSubject: true, trackTime: true });
    assert.equal(both.acceptedItems[0].who[0].name, '민아');
    assert.deepEqual(both.acceptedItems[0].when, { text: '아침', ref: 't1-u' }, 'time and people are checked independently');

    const calls = [];
    f.setReply(args => { calls.push(JSON.stringify(args)); return '{"items":[]}'; });
    const tracking = await api.createLens({ name: '생체 추적', trackSubject: true, instruction: { goal: '몸 상태' }, cadence: { mode: 'manual' } });
    const quiet = await api.createLens({ name: '분위기', instruction: { goal: '분위기' }, cadence: { mode: 'manual' } });
    await api.runLensForRange(tracking.lensId, { startTurn: 1, endTurn: 5 });
    await api.runLensForRange(quiet.lensId, { startTurn: 1, endTurn: 5 });
    assert.match(calls[0], /write a separate note for each person/);
    assert.match(calls[0], /whoRef/);
    assert.match(calls[0], /the character is 민아/, 'the prompt names the character for "char"');
    assert.doesNotMatch(calls[1], /whoRef|People:/, 'the people rules appear only for a tracking lens');
  } finally { await f.close(); }
});

const peopleReply = { items: [
  { label: '약속', text: '열쇠를 오늘 돌려주기로 약속했다.', refs: ['t2-a'], quote: '오늘 돌려주겠다고 약속했다', who: ['지호'] },
  { label: '보관', text: '열쇠를 맡아 들었다.', refs: ['t3-a'], quote: '준호가 지호에게서 열쇠를 받아 들었다', who: ['준호'] },
  { label: '소유', text: '열쇠를 맡아 들었다.', refs: ['t3-a'], quote: '열쇠의 소유자는 여전히 민아다', who: ['민아'] },
  { label: '신뢰', text: '누군가를 신뢰한다고 말했다.', refs: ['t4-a'], quote: '민아는 지호를 신뢰한다고 말했다', who: ['그녀'] }
] };

test('one lens tracks several people; people cards group at read time; recall names them', async () => {
  const f = await lensFixture();
  try {
    const api = f.api;
    f.setReply(peopleReply);
    const lens = await f.add('생체 추적', 'active', { trackSubject: true });
    const run = (await api.inspectScopeLenses()).lenses[lens.lensId].runs[0];
    assert.deepEqual({ n: run.counts.subjectNamed, u: run.counts.subjectUnknown, d: run.counts.subjectDropped }, { n: 3, u: 1, d: 1 });

    let view = plain((await api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId));
    assert.equal(view.length, 4);
    assert.ok(view.every(row => row.whoTracked === true));
    const keys = new Set(view.flatMap(row => row.people.map(person => person.key)));
    assert.equal(keys.size, 3, 'three people, grouped without any setup');
    assert.deepEqual(view.find(row => row.label === '신뢰').people, [], 'a pronoun stays unknown');

    // A people card that lists "지호" with an alias groups another written form under it.
    const registryKey = [...f.r.values.keys()].find(storageKey => storageKey.endsWith(':entity-registry:v2'));
    const registry = registryKey ? JSON.parse(f.r.values.get(registryKey)) : { schema: 'libra.entity_registry.v2', entities: [] };
    registry.entities = (registry.entities || []).filter(entity => entity.type !== 'person');
    registry.entities.push({ id: 'ce_person_jiho', type: 'person', name: '한지호', aliases: ['지호'] }, { id: 'ce_person_a', type: 'person', name: '준호', aliases: [] }, { id: 'ce_person_b', type: 'person', name: '박준호', aliases: ['준호'] });
    const scopeKey = view[0].recordKey && (await api.inspectScopeLenses()).scopeKey;
    f.r.values.set(registryKey || `libra:v1:scope:${scopeKey}:entity-registry:v2`, JSON.stringify(registry));
    view = plain((await api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId));
    const jiho = view.find(row => row.label === '약속').people[0];
    assert.deepEqual({ key: jiho.key, name: jiho.name, written: jiho.written }, { key: 'entity:ce_person_jiho', name: '한지호', written: '지호' }, 'the people card name is shown beside the written name');
    assert.equal(view.find(row => row.label === '보관').people[0].key, 'name:준호', 'a name that matches two people cards is never merged');
    const records = plain(Object.values(JSON.parse(f.r.values.get([...f.r.values.keys()].find(storageKey => storageKey.endsWith(`:lens:${lens.lensId}:records`)))).records));
    assert.equal(records[0].items.find(item => item.label === '약속').who[0].name, '지호', 'the stored record keeps the source wording');

    let recall = await api.recallLensMemories({ query: '한지호 몸 상태와 약속', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /\(T1–T5 · 인물: 한지호 · 약속\)/, 'recall names the person; the people card name counts toward relevance');
    recall = await api.recallLensMemories({ query: '열쇠를 맡아 들었다', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /인물: 준호 · 보관/);
    assert.match(recall.renderedBlock, /인물: 민아 · 소유/, 'same wording about two people is recalled for each');
    recall = await api.recallLensMemories({ query: '신뢰한다고 말했다', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /인물 불명 · 신뢰/);

    const revision = lens.instructionRevision;
    const updated = await api.updateLens(lens.lensId, { trackSubject: false });
    assert.equal(updated.instructionRevision, revision, 'the switch does not change the instruction revision');
    view = plain((await api.inspectScopeLenses()).memories.filter(row => row.lensId === lens.lensId));
    assert.ok(view.every(row => row.whoTracked === true), 'older records keep their own setting');
  } finally { await f.close(); }
});

const inheritedPeople = async f => plain((await f.api.inspectScopeLenses()).memories.filter(row => row.inherited));
const checkInherited = (rows, label) => {
  assert.equal(rows.length, 4, `${label}: all notes arrive`);
  const jiho = rows.find(row => row.label === '약속');
  assert.deepEqual(jiho.who, [{ name: '지호', ref: 't2-a', role: 'named' }], `${label}: people survive`);
  assert.ok(jiho.sourceTurns['t2-a'].includes('지호'), `${label}: the name turn has an excerpt`);
  assert.equal(rows.find(row => row.label === '신뢰').whoTracked, true, `${label}: unknown stays unknown`);
};

test('handoff, a second handoff and portable restore keep people', async () => {
  const f = await lensFixture();
  try {
    f.setReply(peopleReply);
    await f.add('생체 추적', 'active', { trackSubject: true });
    await f.api.prepareSessionHandoff({ transferId: 'people-1' });
    const first = f.target('첫 승계');
    await f.api.adoptSessionHandoff({ transferId: 'people-1', targetChatId: first.id });
    checkInherited(await inheritedPeople(f), 'first handoff');
    await f.api.prepareSessionHandoff({ transferId: 'people-2' });
    const second = f.target('두 번째 승계');
    await f.api.adoptSessionHandoff({ transferId: 'people-2', targetChatId: second.id });
    checkInherited(await inheritedPeople(f), 'second handoff');
    const recall = await f.api.recallLensMemories({ query: '지호 열쇠 약속', canonicalBudgetChars: 12000 });
    assert.match(recall.renderedBlock, /이전 대화\] \(T1–T5 · 인물: 지호 · 약속\)/);

    const portable = f.r.context.__LIBRAPortableMemoryBackup;
    const envelope = await portable.exportCurrentScope();
    const archiveKeys = [...f.r.values.keys()].filter(storageKey => storageKey.includes(':lens-handoff-archive:'));
    assert.ok(archiveKeys.length >= 1);
    for (const storageKey of archiveKeys) f.r.values.delete(storageKey);
    assert.equal((await inheritedPeople(f)).length, 0);
    for (let i = 0; i < 100; i += 1) {
      try { await portable.restoreCurrentScope(envelope); break; }
      catch (error) { if (!/busy|진행|처리/.test(String(error?.message))) throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    checkInherited(await inheritedPeople(f), 'portable restore');
  } finally { await f.close(); }
});

test('a native branch copy keeps people and their name turns', async () => {
  const f = await lensFixture();
  try {
    f.setReply(peopleReply);
    await f.add('생체 추적', 'active', { trackSubject: true });
    f.target('분기', true);
    const result = await f.api.debugNativeChatCopy({ force: true });
    assert.equal(result.result?.ok, true, JSON.stringify(result));
    checkInherited(await inheritedPeople(f), 'native copy');
  } finally { await f.close(); }
});
