'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/gradia_input_writer_unified_fixture.cjs');

const HANGUL_RE = /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/;

test('P0: non-Korean draft prompts, living-world block, quality floor, NSFW explicit & Input Assist avoid Korean leakage', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.host.plugin.debugSetActiveScope('p0-multilingual', 'Alex');

  const enSettings = {
    mode: 'normal',
    writingMode: 'rp',
    internalDraftLanguage: 'english',
    nsfwMode: 'explicit',
    nsfwGuidanceEnabled: true
  };
  const jaSettings = {
    ...enSettings,
    internalDraftLanguage: 'japanese'
  };
  const koSettings = {
    ...enSettings,
    internalDraftLanguage: 'korean'
  };

  const enRecent = {
    latestUser: 'Elena leans closer near the rainy window and lowers her voice.',
    visibleMessages: [
      { role: 'user', content: 'Elena stepped inside the dim lounge.' },
      { role: 'assistant', content: 'Elena brushed rain from her coat and watched Alex carefully.' }
    ],
    summary: 'Elena and Alex met in the lounge during a storm.'
  };

  const jaRecent = {
    latestUser: '佐藤美咲は窓際で声を潜め、ユキの手をそっと握った。',
    visibleMessages: [
      { role: 'user', content: '美咲とユキは静かなラウンジに入った。' },
      { role: 'assistant', content: '美咲は雨粒を払いながらユキを見つめた。' }
    ],
    summary: '美咲とユキは嵐の夜にラウンジで再会した。'
  };

  const enShadowPrompt = f.host.plugin.debugBuildShadowActDraftUserPrompt({
    recent: enRecent,
    settings: enSettings,
    creativeInstructions: 'Keep the tension understated and sensory.'
  });
  const jaShadowPrompt = f.host.plugin.debugBuildShadowActDraftUserPrompt({
    recent: jaRecent,
    settings: jaSettings,
    creativeInstructions: '静かな緊張感を保つこと。'
  });
  const koShadowPrompt = f.host.plugin.debugBuildShadowActDraftUserPrompt({
    recent: { latestUser: '하연이 창가로 다가섰다.', visibleMessages: [] },
    settings: koSettings,
    creativeInstructions: '긴장감을 유지하라.'
  });

  assert.equal(HANGUL_RE.test(enShadowPrompt), false, 'English shadow prompt must not leak Hangul directives');
  assert.equal(HANGUL_RE.test(jaShadowPrompt), false, 'Japanese shadow prompt must not leak Hangul directives');
  assert.match(enShadowPrompt, /\[CURRENT USER INPUT U\[n\]\]/);
  assert.match(jaShadowPrompt, /\[CURRENT USER INPUT U\[n\]\]/);
  assert.match(koShadowPrompt, /\[현재 유저 인풋 U\[n\]\]/);

  const enLiving = f.host.plugin.debugBuildLivingWorldEngineBlock({
    stageName: 'shadow_act',
    recent: enRecent,
    settings: enSettings,
    phase: 'writing'
  });
  const jaLiving = f.host.plugin.debugBuildLivingWorldEngineBlock({
    stageName: 'shadow_act',
    recent: jaRecent,
    settings: jaSettings,
    phase: 'writing'
  });
  assert.equal(HANGUL_RE.test(enLiving), false, 'English living-world block must not contain Hangul');
  assert.equal(HANGUL_RE.test(jaLiving), false, 'Japanese living-world block must not contain Hangul');

  const enQuality = f.host.plugin.debugCompileBaseQualityForStage({ stage: 'shadow_act', phase: 'writing', settings: enSettings });
  const jaQuality = f.host.plugin.debugCompileBaseQualityForStage({ stage: 'shadow_act', phase: 'writing', settings: jaSettings });
  const koQuality = f.host.plugin.debugCompileBaseQualityForStage({ stage: 'shadow_act', phase: 'writing', settings: koSettings });
  assert.equal(HANGUL_RE.test(enQuality), false);
  assert.equal(HANGUL_RE.test(jaQuality), false);
  assert.ok(HANGUL_RE.test(koQuality));

  const enNsfw = f.host.plugin.debugBuildNsfwGuidanceBlock({ settings: enSettings, phase: 'writing' });
  const jaNsfw = f.host.plugin.debugBuildNsfwGuidanceBlock({ settings: jaSettings, phase: 'writing' });
  const koNsfw = f.host.plugin.debugBuildNsfwGuidanceBlock({ settings: koSettings, phase: 'writing' });
  assert.equal(HANGUL_RE.test(enNsfw), false);
  assert.equal(HANGUL_RE.test(jaNsfw), false);
  assert.match(enNsfw, /Vocal register:|English pussy/i);
  assert.match(jaNsfw, /Japanese vocal register:|マンコ/);
  assert.match(koNsfw, /꺄악|가버렷/);

  const enInputAssist = f.host.plugin.debugInputAssistPromptContracts({ settings: enSettings });
  const jaInputAssist = f.host.plugin.debugInputAssistPromptContracts({ settings: jaSettings });
  assert.match(enInputAssist.languageContract, /must be written in English/i);
  assert.match(jaInputAssist.languageContract, /must be written in Japanese/i);
  assert.equal(HANGUL_RE.test(enInputAssist.languageContract), false);
  assert.equal(HANGUL_RE.test(jaInputAssist.languageContract), false);
  assert.equal(HANGUL_RE.test(enInputAssist.rpChoice.join('\n')), false);
  assert.equal(HANGUL_RE.test(jaInputAssist.rpChoice.join('\n')), false);
});

test('P0/P1: Japanese & English person recognition, sceneFixationDetect, and dialogueScanEchoPatterns', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  f.host.plugin.debugSetActiveScope('p0-p1-names-echo', '田中健太');

  const jaPeople = f.host.plugin.debugExtensionPersonHelpers({
    recent: {
      latestUser: '佐藤美咲とユキが会話している。場所とホテルは関係ない。',
      visibleMessages: [
        {
          role: 'assistant',
          content: '佐藤美咲は微笑み、ユキが頷いた。\n[Status]\nLocation: 静かなラウンジ\nCast: 佐藤美咲, ユキ, ホテル\n[/Status]'
        }
      ]
    },
    settings: { internalDraftLanguage: 'japanese' },
    body: '美咲はそっとドアを閉めた。',
    name: '佐藤美咲'
  });
  assert.equal(jaPeople.givenName, '美咲');
  assert.equal(jaPeople.mentionsName, true);
  assert.ok(jaPeople.scenePeople.some(name => /美咲|佐藤美咲/.test(name)));
  assert.ok(jaPeople.scenePeople.includes('ユキ'));
  assert.equal(jaPeople.scenePeople.includes('ホテル'), false);

  const enPeople = f.host.plugin.debugExtensionPersonHelpers({
    recent: {
      latestUser: 'Elena Vance glanced toward Marcus at the bar.',
      visibleMessages: [
        { role: 'assistant', content: '[Status]\nLocation: Dim Bar\nCast: Elena Vance, Marcus\n[/Status]' }
      ]
    },
    settings: { internalDraftLanguage: 'english' },
    body: 'Elena picked up her glass.',
    name: 'Elena Vance'
  });
  assert.equal(enPeople.givenName, 'Elena');
  assert.equal(enPeople.mentionsName, true);
  assert.ok(enPeople.scenePeople.some(name => /Elena/.test(name)));

  const enFixation = f.host.plugin.debugSceneFixationDetect({
    visibleMessages: [
      { role: 'assistant', content: 'She glanced toward the doorway and glanced again before glancing down at the note.' },
      { role: 'assistant', content: 'He glanced at the clock, then glanced over his shoulder while glancing back at the ledger.' },
      { role: 'assistant', content: 'Elena glanced at the rain-streaked glass.' }
    ]
  });
  assert.ok(Array.isArray(enFixation) && enFixation.length > 0);
  assert.ok(enFixation.some(item => /glanc/i.test(item.stem)));

  const jaFixation = f.host.plugin.debugSceneFixationDetect({
    visibleMessages: [
      { role: 'assistant', content: '美咲は窓を見つめた。ユキの手を見つめていると、視線を見つめるしかなかった。' },
      { role: 'assistant', content: '健太もまた扉を見つめた。静かに廊下を見つめている気配を感じて、さらに見つめる。' },
      { role: 'assistant', content: '誰もが無言で闇を見つめた。' }
    ]
  });
  assert.ok(Array.isArray(jaFixation) && jaFixation.length > 0);
  assert.ok(jaFixation.some(item => /見つ/.test(item.stem)));

  const enEcho = f.host.plugin.debugDialogueScanEchoPatterns({
    recent: {
      visibleMessages: [
        { role: 'assistant', content: '"Are you really leaving tonight?" "Yes, I am really leaving tonight." "Wait here tonight." "Stay quiet tonight."' }
      ]
    },
    draftText: '"Listen tonight."'
  });
  assert.ok(enEcho.flags.some(flag => /Echo-loop|Ending convergence/i.test(flag)), 'English quote echo or ending convergence should be detected in flags');

  const jaEcho = f.host.plugin.debugDialogueScanEchoPatterns({
    recent: {
      visibleMessages: [
        { role: 'assistant', content: '「本当に帰るの？」「うん、本当に帰るよ。」「待ってよ。」「聞いてよ。」「見てよ。」' }
      ]
    },
    draftText: '「お願いだから聞いてよ。」'
  });
  assert.ok(jaEcho.flags.some(flag => /Echo-loop|Ending convergence/i.test(flag)), 'Japanese quote echo or ending convergence should be detected in flags');
});

test('P1/P2: Japanese sub-room topology, genre-agnostic acoustics, custom HUD adapter & LLM structuredSignals override', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const scopeKey = 'p1-p2-ja-topology-acoustics';
  f.host.plugin.debugSetActiveScope(scopeKey, 'ユキ');

  const topology = f.host.plugin.debugSpatialTopology({
    recent: {
      latestUser: '美咲とユキの二人だけが浴室に入り、内側から鍵をかけた。健太は客室に残ったままソファに座っている。',
      visibleMessages: [
        {
          role: 'assistant',
          content: 'ホテルの部屋には美咲、ユキ、健太の三人がいた。\n[Status]\nLocation: ホテルの客室\nCast: 美咲, ユキ, 健太\n[/Status]'
        }
      ]
    },
    settings: { internalDraftLanguage: 'japanese' }
  });
  assert.equal(topology.active, true);
  assert.equal(topology.subRoomId, 'bathroom');
  assert.ok(topology.adjacentObservers.some(name => /健太/.test(name)));

  const hudStatusParsed = f.host.plugin.debugParseSceneHud({
    body: 'Rain tapped the lancet windows.\n[Status]\nLocation: Obsidian Spire\nCast: Lyra, Kael\n[/Status]'
  });
  assert.equal(hudStatusParsed.loc, 'Obsidian Spire');
  assert.deepEqual([...hudStatusParsed.names], ['Lyra', 'Kael']);

  const hudXmlParsed = f.host.plugin.debugParseSceneHud({
    body: '<status>location: Neon Alley | present: Vex, Nova</status>'
  });
  assert.equal(hudXmlParsed.loc, 'Neon Alley');
  assert.deepEqual([...hudXmlParsed.names], ['Vex', 'Nova']);

  const hudCustomParsed = f.host.plugin.debugParseSceneHud({
    body: '=== SCENE_META ===\nSECTOR :: Orbital Hangar 9\nCREW :: Mira / Rowan\n=== END ===',
    settings: {
      customHudLocationPattern: 'SECTOR\\s*::\\s*([^\\n]+)',
      customHudCastPattern: 'CREW\\s*::\\s*([^\\n]+)'
    }
  });
  assert.equal(hudCustomParsed.loc, 'Orbital Hangar 9');
  assert.deepEqual([...hudCustomParsed.names], ['Mira', 'Rowan']);

  const stoneVaultPkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'Lyra',
    personaName: 'Kael',
    scopeKey: `${scopeKey}-stone`,
    profileGenders: { Lyra: 'female', Kael: 'male' },
    settings: { internalDraftLanguage: 'english' },
    recent: {
      latestUser: 'Inside the thick stone wall stone vault behind sealed obsidian doors, Kael kissed Lyra as his hand slid between her thighs.',
      visibleMessages: [
        { role: 'assistant', content: '[Status]\nLocation: Obsidian Vault\nCast: Lyra, Kael\n[/Status]' }
      ]
    }
  });
  assert.equal(stoneVaultPkt.externalReaction.acoustics.soundproofing, 'very_high');

  const shojiPkt = f.host.plugin.debugIntimacyPacket({
    characterName: '美咲',
    personaName: 'ユキ',
    scopeKey: `${scopeKey}-shoji`,
    profileGenders: { 美咲: 'female', ユキ: 'male', 健太: 'male' },
    settings: { internalDraftLanguage: 'japanese' },
    recent: {
      latestUser: '障子一枚の薄い壁の向こう、健太が廊下を歩く気配の中で、美咲がユキのペニスを口に含んだ。',
      visibleMessages: [
        { role: 'assistant', content: '古い旅館の障子越しに廊下の足音が聞こえた。美咲とユキは布団の上で息を潜めた。' }
      ]
    }
  });
  assert.equal(shojiPkt.externalReaction.acoustics.soundproofing, 'low');

  const overridePkt = f.host.plugin.debugIntimacyPacket({
    characterName: 'Lyra',
    personaName: 'Kael',
    scopeKey: `${scopeKey}-override`,
    profileGenders: { Lyra: 'female', Kael: 'male', Vex: 'female' },
    settings: { internalDraftLanguage: 'english' },
    recent: {
      latestUser: 'Behind thin paper screens, Kael whispered against Lyra and stroked her clit while Vex waited nearby.',
      visibleMessages: [],
      structuredSignals: {
        spatialTopology: {
          subRoomId: 'sanctum',
          subRoom: 'Inner Sanctum',
          inSubScene: ['Lyra', 'Kael'],
          adjacentObservers: ['Vex']
        },
        acoustics: {
          soundproofing: 'very_high',
          ambientMasking: 'shower_running',
          visualBarrier: 'opaque_locked'
        }
      }
    }
  });
  assert.equal(overridePkt.externalReaction.acoustics.soundproofing, 'very_high');
  assert.equal(overridePkt.externalReaction.acoustics.ambientMasking, 'shower_running');
  assert.equal(overridePkt.externalReaction.acoustics.visualBarrier, 'opaque_locked');
  assert.deepEqual([...overridePkt.externalReaction.spatialTopology.adjacentObservers], ['Vex']);
});

test('P2: draftBudgetForStage and applyDraftBudgetToStagePreset apply universally across all providers without Ollama-only lock', async t => {
  const f = await fixture(t, { writingMode: 'rp', unified: false });
  const settingsMin = { draftBudgetPreset: 'minimum' };
  const settingsBal = { draftBudgetPreset: 'balanced' };

  const providers = [
    { name: 'openai-main', preset: { provider: 'openai', model: 'gpt-5' }, expectOllamaReasoning: false },
    { name: 'anthropic-main', preset: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, expectOllamaReasoning: false },
    { name: 'gemini-main', preset: { provider: 'google_gemini', model: 'gemini-2.5-pro' }, expectOllamaReasoning: false },
    { name: 'ollama-cloud-main', preset: { provider: 'ollama_cloud', model: 'deepseek-v4-flash' }, expectOllamaReasoning: true }
  ];

  for (const item of providers) {
    const minBudget = f.host.plugin.debugDraftBudgetForStage(settingsMin, 'shadow_act', item.preset);
    const balBudget = f.host.plugin.debugDraftBudgetForStage(settingsBal, 'shadow_act', item.preset);
    assert.ok(minBudget && minBudget.label === '최솟값', `${item.name} minimum budget should activate`);
    assert.ok(balBudget && balBudget.label === '밸런스드', `${item.name} balanced budget should activate`);
    assert.equal(minBudget.lightweight, 12288);
    assert.equal(balBudget.lightweight, 16384);

    const appliedMin = f.host.plugin.debugApplyDraftBudgetToStagePreset({
      preset: item.preset,
      budget: minBudget,
      pipelineMode: 'heavyweight'
    });
    assert.equal(appliedMin.max_tokens, minBudget.heavyweight);
    assert.equal(appliedMin.reasoning_effort, 'low');
    if (item.expectOllamaReasoning) {
      assert.equal(appliedMin.reasoning_preset, 'ollama');
    } else {
      assert.equal(appliedMin.reasoning_preset, undefined);
    }
  }
});
