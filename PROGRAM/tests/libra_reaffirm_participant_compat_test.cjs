'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

function transformSource(source) {
  const anchor = '    const canonicalizeUnifiedThreadLifecycle = ';
  assert.ok(source.includes(anchor));
  return source.replace('    const repairUnifiedThreadLinks = ', `    globalThis.__testThreadLinkCompat = async (candidateParticipants, linkKind, linkParticipants) => {
      const registry = {
        schema: 'libra.entity_registry.v2',
        scopeKey: 'scope-test',
        entities: [
          { id: 'ce_person_soyeon', name: '천소연', type: 'person', kind: 'person', aliases: [] },
          { id: 'ce_person_puding', name: '푸딩', type: 'person', kind: 'person', aliases: [] },
          { id: 'ce_person_hayeon', name: '천하연', type: 'person', kind: 'person', aliases: [] }
        ]
      };
      const artifact = {
        schema: 'libra.canonical_artifact.v5',
        entities: [
          { tempId: 'e1', name: '천소연', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't6-a', quote: '내일 아침에 말로 꺼내지 마' }] },
          { tempId: 'e2', name: '푸딩', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't6-u', quote: '알겠어' }] },
          { tempId: 'e3', name: '천하연', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't6-a', quote: '내일 아침에 말로 꺼내지 마' }] }
        ],
        facts: [{
          tempFactId: 'f1',
          domain: 'narrative',
          subjectTempRef: 'e1',
          claimKind: 'thread',
          temporalRole: 'current_sequence',
          certainty: 'confirmed',
          evidenceSpans: [{ ref: 't6-a', quote: '내일 아침에 말로 꺼내지 마' }],
          values: {
            thread: {
              summary: '소연이 내일 아침 이 일을 말로 꺼내지 말라고 요구했고, 상대가 이를 지킬지 미정이다',
              status: 'open',
              kind: 'promise',
              interpretation: '침묵 약속',
              participants: linkParticipants,
              link: linkKind,
              linkCandidateAlias: 'cand_1'
            }
          }
        }],
        stateBindings: [{ factTempId: 'f1', typedValueField: 'thread', stateDomain: 'narrative', stateField: 'threads' }]
      };
      const batch = [
        { turn: 6, user: { text: '알겠어', chatId: 'u6' }, assistant: { text: '내일 아침에 말로 꺼내지 마', chatId: 'a6' } }
      ];
      const basis = {
        scopeKey: 'scope-test',
        worldlineId: 'main',
        registry,
        head: { characters: [], relationships: [], world: { places: [], objects: [], organizations: [], rules: [] }, narrative: { threads: [] }, domainStatus: { characters: {}, relationships: {}, world: {}, narrative: {} } },
        memories: []
      };
      const candidates = [{
          alias: 'cand_1',
          lifecycleId: 'tl_existing',
          canonicalOriginKey: 'libra:v1:scope:scope-test:memory:1:r1',
          cursor: { memoryId: 'mem_000001', revision: 1, sessionEpoch: 0 },
          factId: 'f22',
          participantIds: candidateParticipants,
          lineageDigest: 'lin_1',
          allowedLinks: ['reaffirm', 'resolve', 'replace', 'associate'],
          value: {
            summary: '소연이 내일 아침 이 일을 말로 꺼내지 말라고 요구했고, 상대가 이를 지킬지 미정이다',
            kind: 'promise',
            status: 'open',
            interpretation: '침묵 약속'
          },
          participants: candidateParticipants.map(p => ({ role: p.role, name: p.personId === 'ce_person_soyeon' ? '천소연' : '푸딩' }))
      }];
      const candidateContext = {
        manifest: { memoryId: 'mem_000001', memories: [] },
        candidates,
        byAlias: new Map(candidates.map(c => [c.alias, c]))
      };
      const out = canonicalizeUnifiedThreadLifecycle({ artifact, batch, basis, candidateContext });
      return out.artifact.facts[0].values.thread;
    };
    const repairUnifiedThreadLinks = `);
}

test('reaffirm allows single-participant thread enrichment and swapped role order, while still rejecting wrong participants or resolve mismatch', async t => {
  const x = await serverFixture({ mode: 'plugin_only', transformSource });
  t.after(() => x.cleanup());

  // 1) 1-participant target [천소연] reaffirmed with 2-participant [푸딩, 천소연] -> accepted
  const enriched = await x.f.r.context.__testThreadLinkCompat(
    [{ role: 'owner', personId: 'ce_person_soyeon' }],
    'reaffirm',
    [{ role: 'owner', personTempRef: 'e2' }, { role: 'target', personTempRef: 'e1' }]
  );
  assert.equal(enriched.linkStatus, 'accepted', JSON.stringify(enriched));
  assert.equal(enriched.lifecycleId, 'tl_existing');

  // 2) Same 2 people with swapped owner/target roles -> accepted on reaffirm
  const swapped = await x.f.r.context.__testThreadLinkCompat(
    [{ role: 'owner', personId: 'ce_person_soyeon' }, { role: 'target', personId: 'ce_person_puding' }],
    'reaffirm',
    [{ role: 'owner', personTempRef: 'e2' }, { role: 'target', personTempRef: 'e1' }]
  );
  assert.equal(swapped.linkStatus, 'accepted');
  assert.equal(swapped.lifecycleId, 'tl_existing');

  // 3) Wrong person [푸딩, 천하연] against [천소연] -> still pending participant_mismatch
  const wrongPerson = await x.f.r.context.__testThreadLinkCompat(
    [{ role: 'owner', personId: 'ce_person_soyeon' }],
    'reaffirm',
    [{ role: 'owner', personTempRef: 'e2' }, { role: 'target', personTempRef: 'e3' }]
  );
  assert.equal(wrongPerson.linkStatus, 'pending');
  assert.equal(wrongPerson.linkPendingReason, 'participant_mismatch');

  // 4) State-changing link (resolve) still requires strict participant match
  const strictResolve = await x.f.r.context.__testThreadLinkCompat(
    [{ role: 'owner', personId: 'ce_person_soyeon' }],
    'resolve',
    [{ role: 'owner', personTempRef: 'e2' }, { role: 'target', personTempRef: 'e1' }]
  );
  assert.equal(strictResolve.linkStatus, 'pending');
  assert.equal(strictResolve.linkPendingReason, 'participant_mismatch');
});
