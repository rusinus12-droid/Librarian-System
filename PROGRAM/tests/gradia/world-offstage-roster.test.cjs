'use strict';
// 장면 밖 인물의 "현재 위치" 상태 회귀.
// 이력(로그)만 있고 "지금 어디"가 없으면, 인물이 아무 설명 없이 장면에 나타나거나
// 두 장소에 동시에 존재할 수 있다.
const { test } = require('node:test');
const assert = require('node:assert');
const { load } = require('./host.cjs');

const seed = [
  { id: 'e1', actors: ['민수'], kind: 'movement', place: '골목 창고', cause: '연락을 받음', summary: '약속 장소로 향한다', storyDay: 12 },
  { id: 'e2', actors: ['민수', '지훈'], kind: 'offscene_talk', place: '', cause: '', summary: '창고에서 지훈과 마주친다', storyDay: 12 },
  { id: 'e3', actors: ['세라'], kind: 'movement', place: '병원', cause: '근무', summary: '야간 근무를 시작한다', storyDay: 13 }
];

test('the roster keeps each off-scene person at their last stated place', async () => {
  const host = await load();
  host.plugin.debugSetActiveScope('w1', '하준');
  const roster = host.plugin.debugWorldSimSeed({ scopeKey: 'w1', events: seed });
  const byName = Object.fromEntries(roster.map(item => [item.name, item]));
  assert.equal(byName['민수'].place, '골목 창고', 'a later event without a place keeps the last known place');
  assert.match(byName['민수'].activity, /마주친다/, 'the activity follows the newest event');
  assert.equal(byName['지훈'].place, '골목 창고', 'a companion shares the place of the event they appear in');
  assert.equal(byName['세라'].place, '병원');
});

test('the world dynamics block states the whereabouts and the arrival rule', async () => {
  const host = await load();
  host.plugin.debugSetActiveScope('w2', '하준');
  host.plugin.debugWorldSimSeed({ scopeKey: 'w2', events: seed });
  const block = host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world_dynamics',
    recent: { latestUser: '조용히 방을 나선다.', visibleMessages: [] },
    settings: {
      enableWorldDynamicsAide: true, mode: 'normal', writingMode: 'rp',
      aideStageOrder: ['aide_world_dynamics'], worldSimulatorCast: ['민수', '세라', '지훈']
    }
  });
  assert.match(block, /OFF-SCENE WHEREABOUTS/, 'the block names the current whereabouts section');
  assert.match(block, /민수 @ 골목 창고/, 'a tracked person is reported with their place');
  assert.match(block, /stays where they are until an event moves them/);
  assert.match(block, /never place one person in two places at once/);

  const blockWithSeraOnStage = host.plugin.debugWorldDynamicsStageBlock({
    stageName: 'aide_world_dynamics',
    recent: {
      latestUser: '조용히 방을 나선다.',
      visibleMessages: [{ role: 'assistant', content: '세라가 문을 열고 들어섰다.\n◈CG\nLOC|방|bg|맑음\n@|세라|sera\n◈' }]
    },
    settings: {
      enableWorldDynamicsAide: true, mode: 'normal', writingMode: 'rp',
      aideStageOrder: ['aide_world_dynamics'], worldSimulatorCast: ['민수', '세라', '지훈']
    }
  });
  const whereaboutsSection = blockWithSeraOnStage.slice(
    blockWithSeraOnStage.indexOf('[OFF-SCENE WHEREABOUTS'),
    blockWithSeraOnStage.indexOf('[PERSISTENT OFF-SCENE RECORDS]')
  );
  assert.doesNotMatch(whereaboutsSection, /세라 @ 병원/, 'already-on-stage character is omitted from off-scene whereabouts');
  assert.match(whereaboutsSection, /민수 @ 골목 창고/, 'off-scene character remains listed');
});
