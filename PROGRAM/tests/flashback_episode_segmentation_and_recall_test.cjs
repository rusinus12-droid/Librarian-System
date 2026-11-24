'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createFixture } = require('./fixtures/flashback_native_runtime_fixture.cjs');

const norm = vec => {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
};

const makeRecord = (t, scopeKey, settings, {
  turn,
  text,
  vector,
  structuredStateFacts = [],
  provider = 'openai_compat',
  model = 'ep-test'
}) => t.cleanRecordForMemory({
  id: `ep-rec-${turn}`,
  sourceType: 'response',
  sourceId: `ep-chat:turn:${turn}`,
  text: text || `User:\n턴 ${turn} 질문\n\n---\n\nAssistant:\n${text || `응답 ${turn}`}`,
  title: `Turn ${turn}`,
  scopeKey,
  pairIndex: turn,
  turnIndex: turn,
  tags: [],
  tokenCount: 16,
  tokens: 16,
  vector: norm(vector),
  dim: vector.length,
  provider,
  model,
  embeddingProvider: provider,
  embeddingModel: model,
  embeddingDimensions: vector.length,
  embeddingProfileId: t.embeddingProfileId(settings, vector.length, provider, model),
  createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, turn)).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, turn)).toISOString(),
  lifecycleStatus: 'active',
  sourceHash: `ep-src-${turn}`,
  ...(structuredStateFacts.length ? { structuredStateFacts } : {})
}, { scopeKey }, { authoritativeSource: true }).record;

test('episode segmentation avoids movement-verb over-splitting, bridges 1-turn noise, splits long valleys, merges orphans, and covers late turns in snippets', async () => {
  const f = await createFixture({ arguments: { hook_recall_timeout_ms: '10000' } });
  try {
    const t = f.api._test;
    const scope = await f.api.resolveCurrentScope();
    const settings = t.normalizeSettings({
      ...await f.api.loadSettings(),
      embeddingProvider: 'openai_compat',
      embeddingModel: 'ep-test',
      embeddingDimensions: 4,
      embeddingEnabled: true,
      episodeIndexEnabled: true,
      episodeHierarchyEnabled: true,
      episodeMinRecords: 2,
      episodeMaxRecords: 6,
      episodeParentSize: 6,
      episodeBoundarySimilarity: 0.35
    });

    // Part A: Casual movement verb with strong continuity stays together; explicit time jump + structured location shift split cleanly.
    const partA = [
      makeRecord(t, scope.scopeKey, settings, { turn: 1, text: 'User:\n서재 앞이다.\n\n---\n\nAssistant:\n민아는 서재 안으로 들어섰다.', vector: [1, 0, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 2, text: 'User:\n책상을 본다.\n\n---\n\nAssistant:\n책상 위에는 푸른 촛대가 놓여 있었다.', vector: [0.96, 0.28, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 3, text: 'User:\n고개를 끄덕인다.\n\n---\n\nAssistant:\n...', vector: [0.2, 0.2, 0.96, 0] }), // 1-turn reaction noise
      makeRecord(t, scope.scopeKey, settings, { turn: 4, text: 'User:\n촛대를 살핀다.\n\n---\n\nAssistant:\n민아는 푸른 촛대 아래의 틈새를 다시 만졌다.', vector: [0.95, 0.31, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 5, text: 'User:\n이튿날 아침이 됐다.\n\n---\n\nAssistant:\n이튿날 아침, 준호는 광장으로 나섰다.', vector: [0, 0, 1, 0],
        structuredStateFacts: [{ entity: '준호', property: 'location', value: '중앙 광장', operation: 'set' }] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 6, text: 'User:\n분수대 쪽을 본다.\n\n---\n\nAssistant:\n중앙 광장의 돌바닥에 어젯밤 비가 고여 있었다.', vector: [0.1, 0, 0.99, 0] })
    ];
    const boundsA = t.detectEpisodeBoundaries(partA, settings);
    assert.deepEqual(Array.from(boundsA), [0, 4, 6], `movement verb & 1-turn reaction should stay in scene 1, explicit time jump cuts at 4: ${JSON.stringify(boundsA)}`);

    // Part B: Oversize span (> maxRecords=6) splits at the lowest-similarity valley rather than blind cutoff, and 1-turn tail merges (zero orphans).
    const partB = [];
    for (let turn = 1; turn <= 10; turn += 1) {
      const vec = turn <= 4 ? [1, 0, 0, 0] : turn === 5 ? [0.4, 0.9, 0, 0] : turn <= 9 ? [0, 1, 0, 0] : [0.2, 0.98, 0, 0];
      const text = `User:\n질문 ${turn}\n\n---\n\nAssistant:\n장면 사건 ${turn}: 중요한 단서 번호 ${turn}이 기록됐다.`;
      partB.push(makeRecord(t, scope.scopeKey, settings, { turn, text, vector: vec }));
    }
    const episodesB = t.buildEpisodeIndexRecords(partB, { ...settings, episodeMinRecords: 2, episodeMaxRecords: 6, episodeHierarchyEnabled: false }, scope);
    const coveredTurns = new Set(episodesB.flatMap(ep => ep.childIds));
    assert.equal(coveredTurns.size, 10, 'zero orphan turns dropped from episode index');
    assert.ok(episodesB.every(ep => ep.childCount >= 2), 'all built episodes respect minRecords via post-merge');
    const firstTurnEnd = episodesB[0].turnRange.end;
    assert.ok(firstTurnEnd >= 4 && firstTurnEnd < 6, `valley split chose weak seam around turn 4-5 instead of hard cap 6 (got ${firstTurnEnd})`);

    // Part C: Full-span stratified snippets capture closing turns (>6) and session hierarchy respects major narrative breaks.
    const longSingle = Array.from({ length: 10 }, (_, idx) => makeRecord(t, scope.scopeKey, settings, {
      turn: idx + 1,
      text: `User:\n진행 ${idx + 1}\n\n---\n\nAssistant:\n${idx === 9 ? '결말로 민아가 북쪽 시계탑 열쇠를 품에 숨겼다.' : `중간 서술 ${idx + 1}이 조용히 이어졌다.`}`,
      vector: [1, 0, 0, 0]
    }));
    const singleScene = t.buildEpisodeIndexRecords(longSingle, { ...settings, episodeMinRecords: 2, episodeMaxRecords: 12, episodeHierarchyEnabled: false }, scope);
    assert.equal(singleScene.length, 1);
    assert.ok(singleScene[0].text.includes('북쪽 시계탑 열쇠를 품에 숨겼다'), 'stratified snippets include closing turn beyond index 6');

    // Session hierarchy splits across explicit time jump rather than forcing 6 scenes together.
    const multiScene = [
      makeRecord(t, scope.scopeKey, settings, { turn: 1, text: 'User:\na\n\n---\n\nAssistant:\n장면1 첫 번째 이야기', vector: [1, 0, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 2, text: 'User:\nb\n\n---\n\nAssistant:\n장면1 이어짐', vector: [0.99, 0.14, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 3, text: 'User:\nc\n\n---\n\nAssistant:\n장면2', vector: [0, 1, 0, 0], structuredStateFacts: [{ entity: '민아', property: 'location', value: '아카이브실', operation: 'set' }] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 4, text: 'User:\nd\n\n---\n\nAssistant:\n장면2 이어짐', vector: [0.1, 0.99, 0, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 5, text: 'User:\n10년 후\n\n---\n\nAssistant:\n10년 후, 전혀 다른 시대다.', vector: [0, 0, 1, 0] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 6, text: 'User:\ne\n\n---\n\nAssistant:\n장면3 이어짐', vector: [0, 0, 0.99, 0.1] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 7, text: 'User:\nf\n\n---\n\nAssistant:\n장면4', vector: [0, 0, 0.9, 0.4], structuredStateFacts: [{ entity: '민아', property: 'location', value: '항구 부두', operation: 'set' }] }),
      makeRecord(t, scope.scopeKey, settings, { turn: 8, text: 'User:\ng\n\n---\n\nAssistant:\n장면4 이어짐', vector: [0, 0, 0.88, 0.47] })
    ];
    const hierarchy = t.buildEpisodeIndexRecords(multiScene, { ...settings, episodeMinRecords: 2, episodeMaxRecords: 4, episodeHierarchyEnabled: true, episodeParentSize: 6 }, scope);
    const sessions = hierarchy.filter(ep => ep.episodeLevel === 'session');
    assert.equal(sessions.length, 2, `session hierarchy breaks at explicit time jump instead of merging all scenes: ${JSON.stringify(sessions.map(s => s.turnRange))}`);
    assert.ok(sessions[0].turnRange.end <= 4 && sessions[1].turnRange.start >= 5);
  } finally {
    await f.dispose();
  }
});

test('contextualRecall activates episode sibling expansion, latent location reactivation, and multi-shard child hydration while blocking unrelated queries', async () => {
  const f = await createFixture({ arguments: { hook_recall_timeout_ms: '10000' } });
  try {
    const t = f.api._test;
    const sel = f.api._selectionTest;
    const scope = await f.api.resolveCurrentScope();
    const cfg = t.normalizeSettings({
      ...await f.api.loadSettings(),
      embeddingProvider: 'openai_compat',
      embeddingModel: 'ep-ctx',
      embeddingUrl: 'https://episode-fixture.invalid/v1',
      embeddingDimensions: 4,
      embeddingMaxRetries: 0,
      embeddingBatchSize: 8,
      fallbackHashEmbedding: false,
      embeddingEnabled: true,
      contextualRecall: true,
      autoEpisodeIndex: true,
      episodeIndexEnabled: true,
      episodeHierarchyEnabled: false,
      episodeMinRecords: 2,
      episodeMaxRecords: 4,
      episodeRecallCount: 2,
      episodeChildLimit: 12,
      multiResolutionRecallEnabled: true,
      currentSceneTailEnabled: false,
      entityFocusedRecallEnabled: false,
      recallFullScanThreshold: 1,
      recallShardLimit: 2,
      shardSize: 4,
      topK: 4,
      minScore: 0.25,
      mmrEnabled: false
    });
    await t.saveEmbeddingKeyLocal('fixture-ep-key');
    await f.api.saveSettings(cfg);

    // Vectors:
    //  [1,0,0,0] -> music box query
    //  [0,1,0,0] -> clocktower latent scene / distractors
    //  [0,0,1,0] -> completely unrelated query (must NOT activate episodes)
    f.host.nativeFetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const vecFor = value => {
        const s = String(value);
        if (s.includes('NOT_RELATED_AXIS')) return [0, 0, 1, 0];
        if (s.includes('시계탑')) return [0, 1, 0, 0];
        return [1, 0, 0, 0];
      };
      return new Response(JSON.stringify({ data: inputs.map((x, idx) => ({ index: idx, embedding: norm(vecFor(x)) })) }), { status: 200 });
    };

    const records = [
      // Scene 1 (Turns 1-2): Jade music box + pronoun/ellipsis sibling turn
      makeRecord(t, scope.scopeKey, cfg, {
        turn: 1,
        text: 'User:\n상자를 연다.\n\n---\n\nAssistant:\n민아는 오래된 비취 오르골을 탁자 위에 올려두었다.',
        vector: [1, 0, 0, 0],
        model: 'ep-ctx',
        structuredStateFacts: [{ entity: '민아', property: 'location', value: '민아의 서재', operation: 'set' }]
      }),
      makeRecord(t, scope.scopeKey, cfg, {
        turn: 2,
        text: 'User:\n그걸 돌리면 어떻게 돼?\n\n---\n\nAssistant:\n"그걸 열면 봉인된 기억이 한꺼번에 새어나와." 세린이 경고했다.',
        // Weak direct query similarity (0.14 < minScore 0.25) so ONLY episode child traversal recovers this sibling turn!
        vector: [0.14, 0.99, 0, 0],
        model: 'ep-ctx'
      }),
      // Scene 2 (Turns 3-4): Old clocktower scene (>= 6 turns before latest)
      makeRecord(t, scope.scopeKey, cfg, {
        turn: 3,
        text: 'User:\n탑 꼭대기다.\n\n---\n\nAssistant:\n세린은 북쪽 시계탑 내부에서 거꾸로 도는 은빛 톱니를 보았다.',
        vector: [0, 1, 0, 0],
        model: 'ep-ctx',
        structuredStateFacts: [{ entity: '세린', property: 'location', value: '북쪽 시계탑', operation: 'set' }]
      }),
      makeRecord(t, scope.scopeKey, cfg, {
        turn: 4,
        text: 'User:\n종소리가 들리나?\n\n---\n\nAssistant:\n북쪽 시계탑 종루 밑에 세린을 위한 열쇠 홈이 파여 있었다.',
        vector: [0, 1, 0, 0],
        model: 'ep-ctx'
      }),
      // Turns 5-10: Filler distant turns at the market so ageTurns >= 6 for turns 1-4 and shards split (shardSize=3)
      ...Array.from({ length: 6 }, (_, i) => makeRecord(t, scope.scopeKey, cfg, {
        turn: i + 5,
        text: `User:\n장터 ${i + 5}\n\n---\n\nAssistant:\n노천 시장에서 흔한 빵과 과일만 오갔다 ${i + 5}.`,
        vector: [0, 0, 0, 1],
        model: 'ep-ctx',
        structuredStateFacts: [{ entity: '세린', property: 'location', value: '남쪽 장터', operation: 'set' }]
      }))
    ];
    const builtInitialEps = t.buildEpisodeIndexRecords(records, cfg, scope);
    assert.ok(builtInitialEps.length >= 2, `expected >= 2 episodes across 10 turns, got ${builtInitialEps.length}`);
    await t.saveAllRecords([...records, ...builtInitialEps], { ...cfg, shardSize: 3 }, scope);
    await f.api.retireExternalSources(scope);
    const loadedCheck = await t.loadScopeRecords(scope.scopeKey);
    assert.ok(loadedCheck.manifest.shardCount >= 4, `expected >= 4 shards with shardSize=3, got ${loadedCheck.manifest.shardCount}`);

    // 1. Contextual query for the jade music box recovers BOTH Turn 1 and ellipsis sibling Turn 2 even across multiple shards!
    const musicQuery = await sel.prepareFlashbackRecall('비취 오르골의 위험이 뭐였지?', cfg, scope, {
      currentUser: '비취 오르골의 위험이 뭐였지?',
      messages: [{ role: 'user', content: '비취 오르골의 위험이 뭐였지?' }]
    });
    assert.equal(musicQuery.contextualRecall.mode, 'semantic_embedding');
    assert.ok(musicQuery.episodeTraversal.episodeCount >= 1, `expected episode traversal in contextualRecall mode: ${JSON.stringify(musicQuery.episodeTraversal)}`);
    assert.ok(musicQuery.records.some(item => item.record.text.includes('봉인된 기억이 한꺼번에 새어나와')),
      `ellipsis sibling turn should be recovered via contextual episode expansion: ${musicQuery.records.map(r => r.record.turnIndex).join(',')}`);
    const planMusic = sel.selectFlashbackEvidencePlan(musicQuery, cfg, 3000);
    assert.ok(planMusic.text.includes('봉인된 기억이 한꺼번에 새어나와'));

    // 2. Orthogonal unrelated query at the market activates 0 episodes and injects nothing.
    const unrelated = await sel.prepareFlashbackRecall('NOT_RELATED_AXIS 전혀 다른 이야기', cfg, scope, {
      currentUser: 'NOT_RELATED_AXIS 전혀 다른 이야기'
    });
    assert.equal(unrelated.episodeTraversal.episodeCount, 0);
    assert.equal(sel.selectFlashbackEvidencePlan(unrelated, cfg, 3000).items.length, 0);

    // 3. Move to "북쪽 시계탑" at Turn 11 -> latent episodic reactivation triggers on old Scene 2 even in contextualRecall mode!
    const turn11 = makeRecord(t, scope.scopeKey, cfg, {
      turn: 11,
      text: 'User:\n시계탑으로 간다.\n\n---\n\nAssistant:\n세린은 북쪽 시계탑 문을 열고 안으로 들어섰다.',
      vector: [0, 0, 0, 1],
      model: 'ep-ctx',
      structuredStateFacts: [{ entity: '세린', property: 'location', value: '북쪽 시계탑', operation: 'set' }]
    });
    const allRecords = [...records, turn11];
    const updatedEps = t.buildEpisodeIndexRecords(allRecords, cfg, scope);
    await t.saveAllRecords([...allRecords, ...updatedEps], { ...cfg, shardSize: 3 }, scope);
    await f.api.retireExternalSources(scope);
    const latent = await sel.prepareFlashbackRecall('NOT_RELATED_AXIS 주위를 둘러본다.', cfg, scope, {
      currentUser: 'NOT_RELATED_AXIS 주위를 둘러본다.'
    });
    assert.ok(latent.latentEpisodic.activatedEpisodes >= 1, `expected latent reactivation for 북쪽 시계탑: ${JSON.stringify(latent.latentEpisodic)}`);
  } finally {
    await f.dispose();
  }
});
