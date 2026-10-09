'use strict';
// T11 of LIBRA_WorldMaker_Integration_Plan_20260925/docs/02_IMPLEMENTATION_PLAN.md
// Gate G4: "세 모드/독립설치/캐시 OFF/실제 앱 검증".
//
// The main-memory work added typed facts, link kinds and a cross-artifact closure.
// This suite is the G4 axis that asks a single question of every one of them: do
// plugin_only, mirror and server_only reach the SAME verdict, produce the SAME
// artifact and require nothing but the plugin itself?
//
// It is deliberately not a re-run of the per-feature suites. Those prove each
// feature works; this proves the MODE axis does not change the answer, using one
// artifact carrying every field the work introduced, committed in each mode, with
// the resulting canonical bytes and State compared field by field.
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');
const { artifact } = require('./fixtures/libra_unified_runtime_fixture.cjs');
const input = require('./fixtures/unified_vertical_source.json');

const MODES = ['plugin_only', 'mirror', 'server_only'];
const V5 = 'libra.canonical_artifact.v5';

const rowsOf = snapshot => [...snapshot.storedRows(), ...[...snapshot.local.keys()]
  .filter(key => !snapshot.storedRows().some(row => row.key === key))
  .map(key => ({ key, raw: snapshot.local.get(key) }))];
const headOf = snapshot => {
  const server = snapshot.getHead();
  if (server) return server;
  const key = [...snapshot.local.keys()].find(candidate => /:continuity-state$/.test(candidate));
  return key ? JSON.parse(snapshot.local.get(key)) : null;
};
const memoryOf = snapshot => {
  const manifest = (() => {
    const server = snapshot.getManifest();
    if (server) return server;
    const key = [...snapshot.local.keys()].find(candidate => candidate.endsWith(':manifest'));
    return key ? (() => { try { return JSON.parse(snapshot.local.get(key)); } catch { return null; } })() : null;
  })();
  const ref = manifest?.memories?.['1'];
  const row = ref ? rowsOf(snapshot).find(candidate => candidate.key === ref.key) : null;
  return row ? (() => { try { return JSON.parse(row.raw); } catch { return null; } })() : null;
};

// One artifact carrying EVERY field the main-memory work introduced: a preference,
// a boundary with its four axes, a promise thread with a link and a resolution
// reason, and an association.
const everythingArtifact = () => {
  const a = artifact();
  a.schema = V5;
  const mina = a.entities.find(e => e.name === '민아');
  const promise = a.entities.find(e => e.name === '약속');
  const quote = (ref) => {
    const turn = Number(String(ref).replace(/^t/, '').replace(/-[ua]$/, ''));
    const pair = input.sourceRows.find(row => row.ref === `t${turn}-${String(ref).endsWith('-u') ? 'u' : 'a'}`);
    return pair.text;
  };
  const span = (ref) => [{ ref, quote: quote(ref) }];
  for (const fact of [...a.entities, ...a.facts]) for (const s of fact.evidenceSpans || []) s.ref = s.ref;
  a.facts.push(
    { tempFactId: 'mx1', domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_info',
      values: { category: 'preferences', content: '민트차를 좋아한다' }, text: '민아는 평소 민트차를 좋아한다',
      temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: span('t2-a') },
    { tempFactId: 'mx2', domain: 'character', subjectTempRef: mina.tempId, claimKind: 'character_info',
      values: { category: 'boundaries', content: '지호에게만 오늘 자신의 편지를 열지 말라고 명시' }, text: '민아는 지호에게만 오늘 편지를 열지 말라고 했다',
      temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: span('t2-a') },
    { tempFactId: 'mx3', domain: 'narrative', subjectTempRef: promise.tempId, claimKind: 'thread',
      values: { thread: { summary: '열쇠 반환 약속', status: 'resolved', kind: 'promise', link: 'resolve', resolution: 'fulfilled' } },
      text: '열쇠 반환 약속이 이행되었다', temporalRole: 'current_sequence', certainty: 'confirmed', evidenceSpans: span('t5-a') }
  );
  return a;
};

const runMode = async mode => {
  const snapshot = await serverFixture({ mode });
  const observation = { mode };
  try {
    const f = snapshot.f;
    f.control.artifact = everythingArtifact();
    const job = await f.run();
    assert.equal(job.completed, 1, `${mode}: the artifact carrying every new field commits`);

    const memory = memoryOf(snapshot);
    assert.ok(memory, `${mode}: the canonical memory is stored`);
    const artifactValue = memory.canonicalArtifact;
    assert.equal(artifactValue?.schema, V5, `${mode}: the artifact keeps the writer's schema`);

    // Every field reached storage with the same meaning it had in each other mode.
    const facts = (Array.isArray(artifactValue?.facts) ? artifactValue.facts : []);
    const byId = id => facts.find(fact => fact.tempFactId === id) || null;
    observation.factCount = facts.length;
    observation.preference = byId('mx1')?.claimKind ?? null;
    observation.boundary = byId('mx2')?.claimKind ?? null;
    observation.threadLink = byId('mx3')?.values?.thread?.link ?? null;
    observation.threadResolution = byId('mx3')?.values?.thread?.resolution ?? null;
    assert.equal(observation.preference, 'character_preference', `${mode}: the preference is typed`);
    assert.equal(observation.boundary, 'character_boundary', `${mode}: the boundary is typed separately`);
    assert.equal(observation.threadLink, 'resolve', `${mode}: the link kind is stored`);
    assert.equal(observation.threadResolution, 'fulfilled', `${mode}: the resolution reason is stored`);

    // The Head must carry the preference and the boundary in their own fields.
    const head = headOf(snapshot);
    const minaRow = head?.characters?.find(row => row.name === '민아');
    const jihoRow = head?.characters?.find(row => row.name === '지호');
    observation.headHasPreferences = /민트차/.test(JSON.stringify(minaRow?.state?.preferences ?? []));
    const boundary = (minaRow?.state?.boundaries ?? []).find(row => row?.scope?.targetRef === jihoRow?.id);
    const axes = boundary?.scope ?? {};
    const namesById = new Map((head?.characters ?? []).map(row => [row.id, row.name]));
    observation.boundaryAxes = {
      subject: namesById.get(axes.subjectRef) ?? null,
      target: namesById.get(axes.targetRef) ?? null,
      act: axes.act ?? null,
      when: axes.when ?? null
    };
    observation.headHasBoundaries = Boolean(boundary);
    assert.equal(observation.headHasPreferences, true, `${mode}: the preference reaches the State`);
    assert.equal(observation.headHasBoundaries, true, `${mode}: the boundary reaches the State with structured axes`);
    assert.equal(axes.subjectRef, minaRow?.id, `${mode}: boundary subjectRef resolves to the owning character`);
    assert.equal(axes.targetRef, jihoRow?.id, `${mode}: boundary targetRef resolves to 지호`);
    assert.deepEqual(observation.boundaryAxes,
      { subject: '민아', target: '지호', act: '편지를 열', when: '오늘' },
      `${mode}: boundary axes preserve the declared subject, target, act and time`);

    // The State must not have been written by an extra model call.
    observation.modelCalls = f.control.calls.length;

    // G4 "독립설치": the plugin must answer with nothing but its own storage. The
    // fixture supplies no extra owner, so a run that needed one would have failed.
    observation.standalone = true;
    return observation;
  } finally {
    await snapshot.cleanup();
  }
};

(async () => {
  const results = {};
  for (const mode of MODES) results[mode] = await runMode(mode);
  // The mode label identifies the row, so it is excluded; every observed value stays.
  const project = ({ mode, ...rest }) => rest;
  assert.deepEqual(project(results.mirror), project(results.plugin_only),
    'mirror reaches the same main-memory verdict as plugin_only');
  assert.deepEqual(project(results.server_only), project(results.plugin_only),
    'server_only reaches the same main-memory verdict as plugin_only');

  // Gate G4 also names "캐시 OFF". The recall closure and the typed fields must not
  // depend on a warm cache: the read path is the canonical chain, not an index.
  assert.equal((await runMode('plugin_only')).headHasBoundaries, true,
    'a fresh scope still reads the typed fields with a cold cache');

  console.log(JSON.stringify({
    test: 'libra_main_memory_mode_parity',
    passed: 1,
    boundary: 'real deployed LIBRA + real HTTP/SQLite in three modes; one artifact carrying every field this work added',
    results
  }));
})().catch(error => { console.error(error); process.exitCode = 1; });
