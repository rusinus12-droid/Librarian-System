'use strict';
// Automatic State use applies everything, but a past event, a possibility or a conditional claim keeps saying so.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {create, pause, until} = require('./fixtures/libra_gui_memory_dom_host.cjs');
const {artifact} = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const evidence = [{ref: 't4-a', quote: input.sourceRows.find(r => r.ref === 't4-a').text}];
const build = () => {
  const a = artifact();
  const add = (id, domain, subject, kind, values, text, extra, typed) => {
    a.facts.push({tempFactId: id, domain, subjectTempRef: subject, claimKind: kind, values, text, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: evidence, ...extra});
    a.stateBindings.push({factTempId: id, typedValueField: typed, stateDomain: domain, stateField: typed});
  };
  add('past', 'relationship', 'mina', 'relationship', {value: '과거에 지호가 자신을 좋아했다고 생각했다'}, '민아는 과거에 지호가 자신을 좋아했다고 생각했다.', {targetTempRef: 'jiho', dimension: 'attraction', temporalRole: 'historical'}, 'value');
  add('unsure', 'character', 'mina', 'location', {locationRef: 'hall'}, '민아가 공연실에 있을지도 모른다.', {certainty: 'uncertain'}, 'locationRef');
  add('dependent', 'character', 'jiho', 'knowledge', {knowledge: ['회상에 근거한 짐작']}, '지호가 회상에 근거해 짐작한다.', {dependsOn: ['past']}, 'knowledge');
  return a;
};

(async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'libra-state-meaning-'));
  let f;
  try {
    const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
    const anchor = 'const continuityStatePromptBlock = (head, liveTail = null) => {';
    assert.equal(source.split(anchor).length, 2, 'the prompt block exists');
    const pluginPath = path.join(temporary, 'LIBRA.js');
    fs.writeFileSync(pluginPath, source.replace(anchor, () => `globalThis.__promptBlock = head => continuityStatePromptBlock(head);\n    ${anchor}`));
    f = await create('LIBRA', 'Full', {pluginPath, initialChat: input.sourceRows.map(r => ({role: r.role, chatId: r.ref, data: r.text})),
      host: {runLLMModel: async () => ({type: 'success', result: JSON.stringify(build())})}});
    const {doc, api, context} = f;
    await f.open();
    assert.equal((await api.runManualColdStart()).completed, 1);
    await pause(300);
    const {head} = await api.debugLoadContinuityStateForResponse();
    const person = name => head.characters.find(r => r.name === name);

    // Everything reaches State, but only a current fact can be the value.
    const relation = head.relationships.find(r => r.dimension === 'attraction'), mina = person('민아'), jiho = person('지호');
    assert.equal(relation?.state?.value, undefined, 'a past belief is never the current value');
    assert.equal(relation.fieldCandidates.value[0].value, '과거에 지호가 자신을 좋아했다고 생각했다');
    const study = head.world.find(r => r.name === '서재');
    assert.equal(mina?.state?.locationRef, study.id, 'the confirmed location stands');
    assert.ok(jiho?.state?.knowledge?.includes('회상에 근거한 짐작'));
    assert.equal((head.unifiedApplied?.pending || []).filter(p => ['past', 'unsure', 'dependent'].includes(p.fact)).length, 0);

    // And each field still says what it was.
    assert.equal(relation.fieldCandidates.value[0].temporalRole, 'historical');
    assert.equal(mina.fieldEvidence.locationRef.meaning, undefined, 'the standing value is not marked');
    assert.equal(mina.fieldCandidates.locationRef[0].certainty, 'uncertain');
    assert.equal(mina.fieldCandidates.locationRef[0].claim, '민아가 공연실에 있을지도 모른다.');
    assert.equal(jiho.fieldEvidence.knowledge.meaning.conditional, true);
    assert.equal(jiho.fieldEvidence.knowledge.meaning.restsOn[0], '민아는 과거에 지호가 자신을 좋아했다고 생각했다.');

    // A plain current fact carries no such mark.
    const key = head.world.find(r => r.name === '은빛 열쇠');
    assert.equal(key.fieldEvidence.ownerRef.meaning, undefined);

    // The prompt says it next to the value, and tells the model what to do with it.
    const prompt = context.__promptBlock(head);
    assert.match(prompt, /fieldQualifiers mark a value/);
    assert.match(prompt, /"temporalRole": "historical"/);
    assert.match(prompt, /fieldCandidates list such memories/);
    assert.match(prompt, /"recordedTurn": 4/);
    assert.match(prompt, /recordedTurn and recordedClock when it was recorded/);
    assert.match(prompt, /"certainty": "uncertain"/);
    assert.match(prompt, /"restsOn": \[\s*"민아는 과거에/);
    assert.match(prompt, /"claim": "민아가 공연실에 있을지도 모른다\."/);
    assert.match(prompt, /"value": "공연실"/, 'an id in a candidate reads as its name');

    // The screens show it too.
    doc.querySelector('.sidebar [data-go="people"]').click();
    const minaField = await until(() => doc.querySelector('[data-character-field="locationRef"] [data-state-candidate="set"]'), 'location candidate');
    assert.equal(minaField.querySelector('[data-state-meaning]').dataset.stateMeaning, '불확실');
    const relationBadge = [...doc.querySelectorAll('[data-relationship-id] [data-state-meaning]')].map(n => n.dataset.stateMeaning);
    assert.ok(relationBadge.includes('과거'), 'the relationship line is marked');
    assert.ok([...doc.querySelectorAll('[data-select-row]')].some(n => /서재/.test(n.textContent) && !/공연실/.test(n.textContent)), 'the person list keeps the standing value');

    // The review names it as well.
    const catalog = await api.listMemoryReviews();
    const rows = Object.fromEntries(catalog.rows.map(r => [r.factId, r]));
    assert.equal(rows.past.stateOutcome, 'candidate');assert.equal(rows.past.meaning.temporalRole, 'historical');
    assert.equal(rows.unsure.stateOutcome, 'candidate');assert.equal(rows.unsure.meaning.certainty, 'uncertain');
    assert.equal(rows.dependent.stateOutcome, 'applied');assert.equal(rows.dependent.meaning.conditional, true);
    assert.deepEqual(f.errors, []);
    console.log('PASS past, uncertain and conditional facts reach State with their meaning intact');
  } finally { await f?.close(); fs.rmSync(temporary, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
