'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { serverFixture } = require('./fixtures/libra_server_runtime_fixture.cjs');

function transformSource(source) {
  const anchor = '    const canonicalizeUnifiedThreadLifecycle = ';
  assert.ok(source.includes(anchor));
  const projectionAnchor = '    const unifiedStateReadProjection = ';
  assert.ok(source.includes(projectionAnchor));
  let next = source.replace('    const repairUnifiedThreadLinks = ', `    globalThis.__testThreadLinkCompat = async (candidateParticipants, linkKind, linkParticipants) => {
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
  next = next.replace(projectionAnchor, `    globalThis.__testThreadReplayPendingCompat = async ({ linkKind, linkParticipants, linkPendingReason }) => {
      const scopeKey = 'scope-test';
      const baseRegistry = {
        schema: 'libra.entity_registry.v2',
        scopeKey,
        entities: [
          { id: 'ce_person_soyeon', name: '천소연', type: 'person', kind: 'person', aliases: [] },
          { id: 'ce_person_puding', name: '푸딩', type: 'person', kind: 'person', aliases: [] },
          { id: 'ce_person_hayeon', name: '천하연', type: 'person', kind: 'person', aliases: [] }
        ]
      };
      const priorHead = {
        schema: CONTINUITY_STATE_SCHEMA,
        scopeKey,
        worldlineId: 'main',
        throughTurn: 25,
        status: 'ready',
        characters: [],
        relationships: [],
        world: [],
        narrative: {
          summary: '침묵 약속',
          threads: [{
            id: 'tl_prior_soyeon',
            lifecycleId: 'tl_prior_soyeon',
            title: '천소연',
            summary: '소연이 내일 아침 이 일을 말로 꺼내지 말라고 요구했고, 상대가 이를 지킬지 미정이다',
            status: 'open',
            kind: 'promise',
            interpretation: '다음 날 아침의 침묵 약속이 아직 지켜지지 않았다',
            participants: [{ role: 'owner', personId: 'ce_person_soyeon' }]
          }]
        },
        domainStatus: {
          characters: { status: 'ready', throughTurn: 25 },
          relationships: { status: 'ready', throughTurn: 25 },
          world: { status: 'ready', throughTurn: 25 },
          narrative: { status: 'ready', throughTurn: 25 }
        }
      };
      const mem26 = {
        schema: 'libra.canonical_memory.v1',
        scopeKey,
        unifiedIdentityScope: scopeKey,
        memoryId: 'mem_000026',
        revision: 1,
        sessionEpoch: 0,
        inheritedSessionHistory: false,
        turnRange: { start: 26, end: 30 },
        sourceDigest: 'sd_26',
        artifactDigest: 'ad_26',
        artifactSchema: UNIFIED_ARTIFACT_SCHEMA_V5,
        artifactValidation: { admission: { stateBlocks: [] } },
        sourceOrder: { 't28-u': 1, 't28-a': 2 },
        canonicalArtifact: {
          schema: UNIFIED_ARTIFACT_SCHEMA_V5,
          entities: [
            { tempId: 'e1', name: '천소연', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't28-a', quote: '내일 아침에 말로 꺼내지 마' }] },
            { tempId: 'e2', name: '푸딩', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't28-u', quote: '알겠어' }] },
            { tempId: 'e3', name: '천하연', type: 'person', kind: 'person', evidenceSpans: [{ ref: 't28-a', quote: '내일 아침에 말로 꺼내지 마' }] }
          ],
          facts: [{
            tempFactId: 'f29',
            domain: 'narrative',
            subjectTempRef: 'e1',
            claimKind: 'thread',
            text: '소연의 내일 아침 침묵 요구가 다시 제기되었다',
            temporalRole: 'current_sequence',
            certainty: 'confirmed',
            evidenceSpans: [{ ref: 't28-a', quote: '내일 아침에 말로 꺼내지 마' }],
            values: {
              thread: {
                summary: '소연이 내일 아침 이 일을 말로 꺼내지 말고 무섭다고 말한 것까지 언급하지 말라고 요구했고, 상대가 이를 지킬지 미정이다',
                status: linkKind === 'resolve' ? 'resolved' : 'open',
                ...(linkKind === 'resolve' ? { resolution: 'done' } : {}),
                kind: 'promise',
                interpretation: '다음 날 아침의 침묵 약속이 아직 지켜지지 않았다',
                link: linkKind,
                lifecycleId: 'tl_stale_dup',
                linkStatus: 'pending',
                linkPendingReason,
                participants: [{ role: 'owner', personTempRef: 'e2' }, { role: 'target', personTempRef: 'e1' }],
                participantIds: linkParticipants
              }
            }
          }],
          stateBindings: [{ factTempId: 'f29', typedValueField: 'thread', stateDomain: 'narrative', stateField: 'threads' }]
        }
      };
      const ref26 = {
        key: 'libra:v1:scope:scope-test:memory:26:r1',
        memoryId: 'mem_000026',
        revision: 1,
        turnRange: { start: 26, end: 30 },
        sessionEpoch: 0,
        sourceDigest: 'sd_26',
        artifactDigest: 'ad_26',
        artifactSchema: UNIFIED_ARTIFACT_SCHEMA_V5,
        status: 'committed'
      };
      const manifest = {
        schema: 'libra.manifest.v1',
        scopeKey,
        memories: {
          21: {
            key: 'libra:v1:scope:scope-test:memory:21:r1',
            memoryId: 'mem_000021',
            revision: 1,
            turnRange: { start: 21, end: 25 },
            sessionEpoch: 0,
            sourceDigest: 'sd_21',
            artifactDigest: 'ad_21',
            artifactSchema: UNIFIED_ARTIFACT_SCHEMA_V5,
            status: 'committed'
          },
          26: ref26
        }
      };
      const candidate = buildUnifiedStateCandidate(
        mem26,
        { head: priorHead, registry: baseRegistry, ref: ref26, logicalWorldlineId: 'main', threadTargetIndex: newUnifiedThreadTargetIndex() },
        manifest
      );
      return {
        narrativeStatus: candidate.head.domainStatus.narrative,
        pending: candidate.pending,
        threads: candidate.head.narrative.threads
      };
    };
` + projectionAnchor);
  return next;
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

  // 5) Historical reaffirm with stored pending participant_mismatch resolves cleanly on state replay
  const replayedCompat = JSON.parse(JSON.stringify(await x.f.r.context.__testThreadReplayPendingCompat({
    linkKind: 'reaffirm',
    linkPendingReason: 'participant_mismatch',
    linkParticipants: [{ role: 'owner', personId: 'ce_person_puding' }, { role: 'target', personId: 'ce_person_soyeon' }]
  })));
  assert.equal(replayedCompat.narrativeStatus.status, 'ready');
  assert.equal(replayedCompat.narrativeStatus.throughTurn, 30);
  assert.deepEqual(replayedCompat.pending, []);
  assert.equal(replayedCompat.threads.length, 1, 'no duplicate pending thread inserted');
  assert.equal(replayedCompat.threads[0].id, 'tl_prior_soyeon');

  // 6) Replay still blocks wrong participants or resolve links on stored pending records
  const replayedWrong = JSON.parse(JSON.stringify(await x.f.r.context.__testThreadReplayPendingCompat({
    linkKind: 'reaffirm',
    linkPendingReason: 'participant_mismatch',
    linkParticipants: [{ role: 'owner', personId: 'ce_person_puding' }, { role: 'target', personId: 'ce_person_hayeon' }]
  })));
  assert.equal(replayedWrong.narrativeStatus.status, 'not_updated');
  assert.equal(replayedWrong.narrativeStatus.throughTurn, 25);
  assert.equal(replayedWrong.pending[0].reason, 'thread_link_pending:participant_mismatch');

  const replayedResolve = JSON.parse(JSON.stringify(await x.f.r.context.__testThreadReplayPendingCompat({
    linkKind: 'resolve',
    linkPendingReason: 'participant_mismatch',
    linkParticipants: [{ role: 'owner', personId: 'ce_person_puding' }, { role: 'target', personId: 'ce_person_soyeon' }]
  })));
  assert.equal(replayedResolve.narrativeStatus.status, 'not_updated');
  assert.equal(replayedResolve.narrativeStatus.throughTurn, 25);
  assert.equal(replayedResolve.pending[0].reason, 'thread_link_pending:participant_mismatch');
});
