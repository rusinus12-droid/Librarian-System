'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {load}=require('./host.cjs');

// novel_input_choices_schema_invalid: the model returned usable choices but the
// constant envelope was missing, renamed, nested or replaced by a bare array.
const NOVEL='gradia_novel_input_choices_v1';
const three=[
  {perspective:'user_focus',title:'a',summary:'s',input:'첫 번째 후보 입력입니다.'},
  {perspective:'npc_focus',title:'b',summary:'s',input:'두 번째 후보 입력입니다.'},
  {perspective:'offscreen_focus',title:'c',summary:'s',input:'세 번째 후보 입력입니다.'}
];
const internals=async()=>(await load({captureInternals:true,transformSource:s=>s.replace('fullDraftStagePrompt, Runtime };',
  'fullDraftStagePrompt, Runtime, coerceInputChoicesPayload, normalizeNovelInputChoices, relaxedJsonParse: parseInputChoicesResponse };')})).internals;

test('choice envelopes without the exact schema field are recovered and still validated',async()=>{
  const h=await internals();
  const read=raw=>{const env=h.coerceInputChoicesPayload(h.relaxedJsonParse(raw),NOVEL);return {env,choices:env.schemaOk?h.normalizeNovelInputChoices(env.payload,''):[]};};
  for(const raw of [
    JSON.stringify({schema:NOVEL,choices:three}),
    JSON.stringify({choices:three}),
    JSON.stringify({schema:'gradia_novel_input_choices',choices:three}),
    JSON.stringify({result:{choices:three}}),
    '```json\n'+JSON.stringify({candidates:three})+'\n```',
    JSON.stringify(three)
  ]){
    const {env,choices}=read(raw);
    assert.equal(env.schemaOk,true,raw);
    assert.deepEqual([...choices].map(c=>String(c.perspective)),['user_focus','npc_focus','offscreen_focus'],raw);
  }
  // Unlabeled candidates in the requested order keep their position.
  const unlabeled=read(JSON.stringify({choices:three.map(({perspective,...rest})=>rest)}));
  assert.deepEqual([...unlabeled.choices].map(c=>String(c.perspective)),['user_focus','npc_focus','offscreen_focus']);
  // A different artifact or prose is still rejected.
  assert.equal(read(JSON.stringify({schema:'serial_gradation_agents_for_rp_draft_patch_v1',choices:three})).env.schemaOk,false);
  assert.equal(read('선택지를 만들 수 없습니다.').env.schemaOk,false);
  assert.equal(read(JSON.stringify({schema:NOVEL,choices:[]})).env.schemaOk,false);
});
