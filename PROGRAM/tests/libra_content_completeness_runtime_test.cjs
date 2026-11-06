'use strict';
// Content completeness: profile, place description, story structure, closed threads
// and the screens that read them. Controlled provider; shipped plugin and storage.
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { fixture } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const { fiveMore } = require('./fixtures/libra_server_runtime_fixture.cjs');

const AUDIT_MARKER = '  const publicApi = Object.freeze({\n    getHostLineageStatus: () => LibraMemoryCore';
const transformSource = source => {
  assert.ok(source.includes(AUDIT_MARKER), 'audit marker');
  return source.replace(AUDIT_MARKER, '  globalThis.__audit={Gui,LibraMemoryCore,worldManagerSnapshotView,buildApprovedMockupPeople,bookWorldAtlasModel,bookNarrativeModel,worldManagerDisplayReferences};\n' + AUDIT_MARKER);
};
const domGlobals = () => {
  const dom = new JSDOM('<!doctype html><html lang="ko"><body></body></html>');
  return { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node };
};
const results = [];
const check = (name, fn) => { fn(); results.push(name); };
const row = (f, turn, role) => f.chat.message[(turn - 1) * 2 + (role === 'a' ? 1 : 0)];
const ev = (ref, quote) => [{ ref, quote }];
const v5 = f => { f.control.artifact.schema = 'libra.canonical_artifact.v5'; };
const fact = (id, domain, subject, claimKind, values, text, spans, extra = {}) =>
  ({ tempFactId: id, domain, subjectTempRef: subject, claimKind, values, text, temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: spans, ...extra });

async function run() {
  const calls = { structure: 0, profile: 0 };
  const f = await fixture({ transformSource, contextGlobals: domGlobals() });
  try {
    v5(f);
    const a = f.control.artifact;
    row(f, 1, 'a').data += ' 민아는 바닷가 마을에서 자랐다. 도서관은 오래된 석조 건물로 마을 사람들이 책을 빌리는 곳이다.';
    row(f, 4, 'a').data += ' 민아는 지호에게 "다시는 내 일기를 읽지 마."라고 말했다. 민아는 안도했다.';
    a.facts.push(fact('emo', 'character', 'mina', 'character_emotion', { emotion: '안도' }, '민아는 안도했다.', ev('t4-a', '민아는 안도했다.')));
    // Background is about the past by nature; it still describes who she is now.
    a.facts.push(fact('bg', 'character', 'mina', 'character_info', { category: 'background', content: '바닷가 마을에서 자랐다' },
      '민아는 바닷가 마을에서 자랐다.', ev('t1-a', '민아는 바닷가 마을에서 자랐다.'), { temporalRole: 'historical' }));
    a.facts.push(fact('desc', 'world', 'library', 'world_description', { description: '오래된 석조 건물로 마을 사람들이 책을 빌리는 곳' },
      '도서관은 오래된 석조 건물이다.', ev('t1-a', '도서관은 오래된 석조 건물로 마을 사람들이 책을 빌리는 곳이다.')));
    a.entities.push({ tempId: 'arc1', name: '열쇠의 행방', type: 'world', kind: 'thread', evidenceSpans: ev('t2-a', '지호가 민아 소유의 은빛 열쇠를 빌려 받았고') });
    a.entities.push({ tempId: 'mot1', name: '은빛 열쇠', type: 'world', kind: 'thread', evidenceSpans: ev('t2-a', '은빛 열쇠') });
    a.entities.push({ tempId: 'mot2', name: '한 번뿐인 장면', type: 'world', kind: 'thread', evidenceSpans: ev('t2-a', '은빛 열쇠') });
    a.entities.push({ tempId: 'tp1', name: '열쇠 반환', type: 'world', kind: 'thread', evidenceSpans: ev('t5-a', '지호가 그것을 민아에게 돌려주었다') });
    a.facts.push(fact('arc', 'narrative', 'arc1', 'story_arc', { arc: { summary: '빌려 간 열쇠가 여러 손을 거쳐 민아에게 돌아온다', status: 'active' } },
      '열쇠의 행방', [...ev('t2-a', '지호가 민아 소유의 은빛 열쇠를 빌려 받았고'), ...ev('t3-a', '준호가 지호에게서 열쇠를 받아 들었다')]));
    a.facts.push(fact('motif', 'narrative', 'mot1', 'motif', { motif: { summary: '은빛 열쇠가 손에서 손으로 옮겨 간다' } },
      '은빛 열쇠', [...ev('t2-a', '은빛 열쇠를 빌려 받았고'), ...ev('t3-a', '열쇠를 받아 들었다')]));
    a.facts.push(fact('motif_once', 'narrative', 'mot2', 'motif', { motif: { summary: '한 턴 안의 반복은 반복 소재가 아니다' } },
      '한 번뿐인 장면', [...ev('t2-u', '은빛 열쇠를 내밀었다'), ...ev('t2-a', '은빛 열쇠를 빌려 받았고')]));
    a.facts.push(fact('tp', 'narrative', 'tp1', 'turning_point', { turningPoint: { summary: '열쇠가 주인에게 돌아왔다' } },
      '열쇠 반환', ev('t5-a', '지호가 그것을 민아에게 돌려주었다')));
    f.control.onSupplementCall = args => {
      const system = args[0].messages.find(m => m.role === 'system').content;
      if (system.includes('[LIBRA PREFERENCE AND BOUNDARY CHECK]')) {
        calls.profile++;
        const user = args[0].messages.find(m => m.role === 'user').content;
        assert.ok(user.includes('읽지 마'), 'cue window is sent');
        assert.ok(!user.includes('정숙 구역'), 'only cue windows are sent, not the whole batch');
        return { type: 'success', result: JSON.stringify({ items: [
          { personRef: 'mina', category: 'boundary', content: '지호에게 자신의 일기를 다시는 읽지 말라고 했다', ref: 't4-a', quote: '다시는 내 일기를 읽지 마.', speakerQuote: '민아는 지호에게' },
          // The name appears only as the recipient: not attributable to 지호.
          { personRef: 'jiho', category: 'boundary', content: '일기를 읽지 않는다', ref: 't4-a', quote: '다시는 내 일기를 읽지 마.', speakerQuote: '지호에게' }
        ] }) };
      }
      if (system.includes('[LIBRA STORY STRUCTURE]')) { calls.structure++; return { type: 'success', result: '{"arcs":[],"turningPoints":[],"motifs":[]}' }; }
      throw new Error("unexpected supplementary call");
    };
    const first = await f.run();
    assert.equal(first.completed, 1, JSON.stringify(first));
    const memory = f.getMemory(), head = f.getHead();
    const mina = head.characters.find(c => c.name === '민아'), jiho = head.characters.find(c => c.name === '지호');
    const library = head.world.find(w => w.name === '도서관');
    check('historical background reaches State', () => assert.deepEqual(mina.state.background, ['바닷가 마을에서 자랐다']));
    check('place description is stored with evidence', () => {
      assert.deepEqual(library.state.description, ['오래된 석조 건물로 마을 사람들이 책을 빌리는 곳']);
      assert.ok(library.fieldEvidence.description.evidenceSpans.length);
    });
    check('arc, turning point and recurring motif are stored', () => {
      assert.deepEqual(head.narrative.arcs.map(r => r.title), ['열쇠의 행방']);
      assert.deepEqual(head.narrative.turningPoints.map(r => r.title), ['열쇠 반환']);
      assert.deepEqual(head.narrative.motifs.map(r => r.title), ['은빛 열쇠']);
      assert.equal(head.narrative.primaryArcId, head.narrative.arcs[0].id, 'the active arc is the derived main arc');
    });
    check('a motif cited in one turn only is rejected', () =>
      assert.ok(memory.artifactValidation.admission.rejected.some(r => r.id === 'motif_once' && /MOTIF_RECURRENCE/.test(r.reason))));
    check('structure pass is skipped when extraction already has structure', () => assert.equal(calls.structure, 0));
    check('preference/boundary check attributes only to the speaking person', () => {
      assert.equal(calls.profile, 1);
      assert.ok((mina.state.boundaries || []).some(item => /일기/.test(item.content)), JSON.stringify(mina.state.boundaries));
      assert.ok(!(jiho?.state?.boundaries || []).length, 'recipient name never attributes');
    });
    check('a resolved thread stays readable as finished', () => {
      assert.ok(!head.narrative.threads.some(t => /반환/.test(t.summary)));
      assert.ok(head.narrative.closedThreads.some(t => /반환/.test(t.summary) && t.status === 'resolved'));
    });

    // Screens read the same Head after the normal load path.
    const audit = f.r.context.__audit;
    await audit.LibraMemoryCore.refreshSnapshot(undefined, { suppressGuiSchedule: true });
    const view = audit.worldManagerSnapshotView();
    check('load keeps structure rows and closed threads', () => {
      assert.equal(view.narrative.turningPoints.length, 1);
      assert.equal(view.narrative.motifs.length, 1);
      assert.equal(view.narrative.closedThreads.length, 1);
    });
    const atlas = audit.bookWorldAtlasModel(view);
    check('place with a description has a lead; a name-only place has none', () => {
      assert.match(atlas.find(i => i.title === '도서관').lead, /석조 건물/);
      assert.equal(atlas.find(i => i.title === '서재').lead, '');
    });
    const groups = audit.bookNarrativeModel(view, []);
    check('story tabs show flow, turning point, motif and the finished thread', () => {
      assert.ok(groups.arcs.some(i => i.kind === '이야기 흐름' && i.title === '열쇠의 행방'));
      assert.ok(groups.arcs.some(i => i.kind === '전환점' && i.status === '전환 기록'));
      assert.ok(groups.arcs.some(i => i.kind === '반복 소재' && /2개 턴/.test(i.status)));
      assert.ok(groups.closed.some(i => /반환/.test(i.title + ' ' + i.body) && i.status === '해결됨'));
    });
    check('unresolved internal id is never shown as a name', () => {
      assert.equal(audit.worldManagerDisplayReferences('ce_world_87c91f6f', view, 'locationRef'), '이름 확인 필요한 장소');
      assert.equal(audit.worldManagerDisplayReferences(library.id, view, 'locationRef'), '도서관');
    });
    const people = id => { audit.Gui.bookSelectedCharacterId = id; audit.Gui.worldManagerSelectedCharacterId = id; return audit.buildApprovedMockupPeople(); };
    check('belongings tab lists owned/held objects from the person side, without places', () => {
      const own = people(mina.id).querySelector('[data-subpanel="own"]').textContent;
      assert.match(own, /소유 · 소지 중 · 은빛 열쇠/);
      assert.doesNotMatch(own, /현재 위치/);
      assert.doesNotMatch(own, /기록된 항목이 없습니다/);
    });
    check('emotion reads under the current situation, not as an extra intro field', () => {
      const node = people(mina.id);
      assert.match(node.querySelector('[data-subpanel="now"]').textContent, /안도/);
      assert.doesNotMatch(node.querySelector('[data-subpanel="intro"]').textContent, /안도/);
    });
    check('boundary reads as a sentence, not a field dump', () => {
      const bound = people(mina.id).querySelector('[data-subpanel="bound"]').textContent;
      assert.match(bound, /일기를 다시는 읽지 말라고/);
      assert.doesNotMatch(bound, /주제:|분류:|scope/);
    });

    // Replay and restart keep the same content.
    const before = JSON.stringify({ n: f.getHead().narrative, w: f.getHead().world.map(w => w.state), c: f.getHead().characters.map(c => c.state) });
    assert.equal((await f.r.api.rebuildWorldManagerState()).ok, true);
    const replayed = JSON.stringify({ n: f.getHead().narrative, w: f.getHead().world.map(w => w.state), c: f.getHead().characters.map(c => c.state) });
    check('replay rebuilds the same profile, description and structure', () => {
      const pick = s => { const x = JSON.parse(s); return { arcs: x.n.arcs.map(r => r.title), tp: x.n.turningPoints.map(r => r.title), motifs: x.n.motifs.map(r => r.title), closed: x.n.closedThreads.map(r => r.summary), w: x.w, c: x.c }; };
      assert.deepEqual(pick(replayed), pick(before));
    });
    const restarted = await fixture({ snapshot: { chat: f.chat, values: [...f.r.values] }, transformSource, contextGlobals: domGlobals() });
    try {
      check('restart reads the same canonical artifact', () => assert.deepEqual(restarted.getMemory().canonicalArtifact, memory.canonicalArtifact));
    } finally { await restarted.r.cleanup(); }

    // Second batch: no structure in the extraction, so the structure pass composes it
    // from the batch's own events, by id, with their verified evidence.
    fiveMore(f); v5(f);
    const b = f.control.artifact;
    b.facts.push(fact('e1', 'event', 'jiho', 'event', { detail: '지호가 열쇠를 빌렸다' }, '지호가 열쇠를 빌렸다.', ev('t7-a', '지호가 민아 소유의 은빛 열쇠를 빌려 받았고')));
    b.facts.push(fact('e2', 'event', 'junho', 'event', { detail: '준호가 열쇠를 받았다' }, '준호가 열쇠를 받았다.', ev('t8-a', '준호가 지호에게서 열쇠를 받아 들었다')));
    b.facts.push(fact('e3', 'event', 'jiho', 'event', { detail: '지호가 열쇠를 돌려주었다' }, '지호가 열쇠를 돌려주었다.', ev('t10-a', '지호가 그것을 민아에게 돌려주었다')));
    f.control.onSupplementCall = args => {
      const system = args[0].messages.find(m => m.role === 'system').content;
      if (system.includes('[LIBRA STORY STRUCTURE]')) {
        calls.structure++;
        const user = args[0].messages.find(m => m.role === 'user').content;
        assert.ok(user.includes('열쇠의 행방'), 'prior arc titles are offered for continuation');
        return { type: 'success', result: JSON.stringify({
          arcs: [{ title: '열쇠의 행방', summary: '열쇠가 다시 여러 손을 거쳐 돌아온다', status: 'resolved', eventIds: ['e1', 'e3'] }],
          turningPoints: [{ title: '열쇠의 행방', summary: '같은 제목은 다른 종류로 쓰지 않는다', eventId: 'e3' }],
          motifs: [{ title: '건네지는 열쇠', summary: '열쇠가 건네진다', eventIds: ['e1', 'e2'] }, { title: '근거 없는 소재', summary: '없는 사건', eventIds: ['nope'] }],
          locks: [{ title: '열쇠는 민아 소유', summary: '열쇠의 소유자는 민아로 유지된다', status: 'active', eventIds: ['e1'] }],
          momentum: { title: '현재 압력', summary: '돌아온 열쇠로 무엇을 열지가 남아 있다', eventIds: ['e3'] } }) };
      }
      if (system.includes('[LIBRA PREFERENCE AND BOUNDARY CHECK]')) return { type: 'success', result: '{"items":[]}' };
      throw new Error("unexpected supplementary call");
    };
    assert.equal((await f.run()).completed, 1);
    const next = f.getHead().narrative;
    check('structure pass continues the arc by title and resolves it', () => {
      assert.equal(calls.structure, 1);
      assert.ok(!next.arcs.some(r => r.title === '열쇠의 행방'));
      assert.ok(next.resolvedArcs.some(r => r.title === '열쇠의 행방' && r.status === 'resolved' && r.firstTurn === 2));
    });
    check('composed entries cite only listed events; one title names one kind', () => {
      assert.ok(next.motifs.some(r => r.title === '건네지는 열쇠' && r.evidenceSpans.some(s => s.ref === 't7-a') && r.evidenceSpans.some(s => s.ref === 't8-a')));
      assert.ok(!next.motifs.some(r => r.title === '근거 없는 소재'));
      assert.ok(!next.turningPoints.some(r => r.title === '열쇠의 행방'));
    });
    check('continuity lock and momentum are stored with evidence; the main arc is derived', () => {
      assert.ok(next.locks.some(r => r.title === '열쇠는 민아 소유' && r.status === 'active' && r.evidenceSpans.some(s => s.ref === 't7-a')));
      assert.equal(next.momentum, '돌아온 열쇠로 무엇을 열지가 남아 있다');
      assert.ok(next.fieldEvidence.momentum.evidenceSpans.some(s => s.ref === 't10-a'));
      assert.equal(next.primaryArcId, '', 'the only arc is resolved, so no main arc remains');
    });
    check('earlier profile and description are kept when the next batch omits them', () => {
      const h = f.getHead();
      assert.deepEqual(h.characters.find(c => c.name === '민아').state.background, ['바닷가 마을에서 자랐다']);
      assert.deepEqual(h.world.find(w => w.name === '도서관').state.description, ['오래된 석조 건물로 마을 사람들이 책을 빌리는 곳']);
    });
    console.log('PASS ' + results.length + ' checks: ' + results.join('; '));
  } finally { await f.r.cleanup(); }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
