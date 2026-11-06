'use strict';
// Defects seen in the 2026-11-06 real-model measurement, reproduced with a controlled provider:
// a quote with a stray opening quotation mark dropped a whole task thread, the same profile
// trait was stored several times in different wording, and Micro objects lost their kind.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');

const ev = (ref, quote) => [{ ref, quote }];
const fact = (id, domain, subject, claimKind, values, text, spans, extra = {}) =>
  ({ tempFactId: id, domain, subjectTempRef: subject, claimKind, values, text, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: spans, ...extra });

async function run() {
  const f = await fixture();
  try {
    const a = f.control.artifact; a.schema = 'libra.canonical_artifact.v5';
    // The source opens the dialogue earlier; the provider copies the mark onto a later sentence.
    f.chat.message[3].data += ' "약속할게. 오늘 저녁까지 열쇠를 돌려줄게." 민아는 갈색 눈을 지녔다.';
    a.entities.push({ tempId: 'task', name: '열쇠 반환', type: 'world', kind: 'thread', evidenceSpans: ev('t2-a', '열쇠를 돌려줄게') });
    a.facts.push(fact('edge', 'narrative', 'task', 'thread', { thread: { summary: '지호가 오늘 저녁까지 열쇠를 돌려주기로 했다', status: 'open', kind: 'promise' } },
      '열쇠 반환 약속', ev('t2-a', '"오늘 저녁까지 열쇠를 돌려줄게."')));
    a.facts.push(fact('eye1', 'character', 'mina', 'character_appearance', { appearance: ['갈색 눈'] }, '민아의 눈은 갈색이다.', ev('t2-a', '갈색 눈')));
    a.facts.push(fact('eye2', 'character', 'mina', 'character_appearance', { appearance: ['민아는 갈색 눈을 지녔다.'] }, '민아는 갈색 눈을 지녔다.', ev('t2-a', '민아는 갈색 눈을 지녔다.')));
    // Lore wording that the chat never uses (윤기, 선명한) is kept as memory, not as appearance.
    a.facts.push(fact('lore', 'character', 'mina', 'character_appearance', { appearance: ['길고 윤기 나는 갈색 머리와 선명한 갈색 눈'] }, '민아는 길고 윤기 나는 머리를 지녔다.', ev('t2-a', '민아는 갈색 눈을 지녔다.')));
    assert.equal((await f.run()).completed, 1);
    const memory = f.getMemory(), head = f.getHead();
    const lore = memory.canonicalArtifact.facts.find(x => x.tempFactId === 'lore');
    assert.equal(lore?.claimKind, 'character_note', 'lore-embellished appearance stays memory-only');
    assert.ok(memory.artifactValidation.admission.normalizedFields.some(x => x.reason === 'profile_wording_not_in_source_memory_only'));
    const kept = memory.canonicalArtifact.facts.find(x => x.tempFactId === 'edge');
    assert.ok(kept, 'the thread is kept instead of rejected for an edge quotation mark');
    assert.equal(kept.evidenceSpans[0].quote, '오늘 저녁까지 열쇠를 돌려줄게.', 'only the edge marks are removed');
    assert.ok(memory.artifactValidation.admission.normalizedFields.some(x => x.reason === 'edge_quotation_marks_trimmed'));
    assert.ok(head.narrative.threads.some(t => /열쇠를 돌려주기로/.test(t.summary)), 'the open task reaches State and can be closed later');
    assert.deepEqual(head.characters.find(c => c.name === '민아').state.appearance, ['민아는 갈색 눈을 지녔다.'], 'one trait, fuller wording kept');
  } finally { await f.r.cleanup(); }

  // A thread whose people were never named must still be offered, so a later batch can close it.
  const g = await fixture();
  try {
    const { fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');
    const { candidateRowsFromPrompt } = require('./fixtures/libra_q04_thread_fixture.cjs');
    const b = g.control.artifact; b.schema = 'libra.canonical_artifact.v5';
    b.facts = b.facts.filter(x => x.claimKind !== 'thread');
    b.entities.push({ tempId: 'visit', name: '서재 방문 과제', type: 'world', kind: 'thread', evidenceSpans: ev('t2-a', '민아가 서재에 도착했다') });
    b.facts.push(fact('task', 'narrative', 'visit', 'thread', { thread: { summary: '서재에 가서 열쇠를 돌려받는 과제', status: 'open', kind: 'task' } },
      '서재에서 열쇠를 돌려받는 과제가 남았다.', ev('t2-a', '오늘 돌려주겠다고 약속했다')));
    assert.equal((await g.run()).completed, 1);
    assert.ok(g.getHead().narrative.threads.some(t => /돌려받는 과제/.test(t.summary)));
    fiveMore(g); const c = g.control.artifact; c.schema = 'libra.canonical_artifact.v5';
    c.facts = c.facts.filter(x => x.claimKind !== 'thread');
    let offered = [];
    g.control.onCall = args => {
      offered = candidateRowsFromPrompt(args[0]);
      const next = structuredClone(c);
      next.entities.push({ tempId: 'visit', name: '서재 방문 과제', type: 'world', kind: 'thread', evidenceSpans: ev('t10-a', '지호가 그것을 민아에게 돌려주었다') });
      next.facts.push(fact('done', 'narrative', 'visit', 'thread', { thread: { summary: '서재에 가서 열쇠를 돌려받는 과제', status: 'resolved', kind: 'task',
        link: 'resolve', resolution: 'fulfilled', linkCandidateAlias: offered[0]?.alias } }, '열쇠를 돌려받아 과제가 끝났다.', ev('t10-a', '서재에서 준호가 열쇠를 지호에게 건넸고, 지호가 그것을 민아에게 돌려주었다')));
      return { type: 'success', result: JSON.stringify(next) };
    };
    assert.equal((await g.run()).completed, 1);
    assert.equal(offered.length, 1, 'the unnamed open task is offered as a candidate');
    const n = g.getHead().narrative;
    assert.ok(!n.threads.some(t => /돌려받는 과제/.test(t.summary)), 'the task is no longer open');
    assert.ok(n.closedThreads.some(t => /돌려받는 과제/.test(t.summary) && t.resolution === 'fulfilled' && !t.linkPending), 'it is finished, linked to the same story');
  } finally { await g.r.cleanup(); }

  // Micro: a held or stored thing is an object when the producer leaves its kind out.
  const source = fs.readFileSync(path.join(__dirname, '../plugins/LIBRA.js'), 'utf8');
  assert.match(source, /const fieldKind = domain === 'world' && \['holderRef', 'containerRef'\]\.includes\(field\) \? 'object' : domain === 'world' && field === 'sceneTime' \? 'location' : '';/);
  // A scene time belongs to a place; a clock reading is never taken as the place's name.
  assert.match(source, /return pending\('scene_time_target_not_place'\)/);
  assert.match(source, /target\.entityKind \|\| fieldKind \|\| 'other'/);
  console.log('PASS edge quotation marks no longer drop a fact; same trait stored once; Micro held objects keep kind object');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
