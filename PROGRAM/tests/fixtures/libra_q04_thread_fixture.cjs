'use strict';
// Phase B: actual provider prompt -> runtime candidate resolver -> canonical
// storage -> State projection. The controlled provider reads only request-local
// aliases from the prompt; it never receives or invents persistent identifiers.
const assert = require('node:assert/strict');
const { fixture } = require('./libra_unified_runtime_fixture.cjs');

const {countCalls,classifyCall} = require('./libra_provider_call_kinds.cjs');
const rows = [];
const batches = [
  [
    ['민아는 지호에게 은빛 열쇠를 건넸다.', '지호는 오늘 열쇠 반환 약속을 했다.'],
    ['두 사람은 도서관에서 대화를 나눴다.', '대화가 끝났다.'],
    ['민아는 서재에 남았다.', '지호는 열쇠를 가지고 떠났다.'],
    ['준호는 공연실에 있었다.', '준호는 약속 내용에 관여하지 않았다.'],
    ['도서관은 문을 닫았다.', '아직 열쇠 반환은 확인되지 않았다.']
  ],
  [
    ['민아는 공연실에 들어갔다.', '민아는 준호에게 인사했다.'],
    ['지호는 서재에 왔다.', '지호는 민아를 찾았다.'],
    ['민아는 도서관을 나갔다.', '지호는 계속 기다렸다.'],
    ['준호는 열쇠를 보지 못했다.', '준호는 약속을 알지 못했다.'],
    ['지호가 은빛 열쇠를 민아에게 돌려주었다.', '오늘 열쇠 반환 다짐이 이행되었다.']
  ]
];
for (let b = 0; b < batches.length; b += 1) {
  for (let i = 0; i < 5; i += 1) {
    const turn = b * 5 + i + 1;
    rows.push({ turn, role: 'user', text: batches[b][i][0] });
    rows.push({ turn, role: 'assistant', text: batches[b][i][1] });
  }
}
const chat = {
  id: 'thread-lifecycle-chat',
  chatId: 'thread-lifecycle-chat',
  name: 'Thread lifecycle two-batch fixture',
  message: rows.map(row => ({ role: row.role, chatId: `t${row.turn}-${row.role === 'user' ? 'u' : 'a'}`, data: row.text }))
};
const quote = (turn, role = 'assistant') => {
  const row = rows.find(item => item.turn === turn && item.role === (role === 'user' ? 'user' : 'assistant'));
  return { ref: `t${turn}-${role === 'user' ? 'u' : 'a'}`, quote: row.text };
};
const candidateRowsFromPrompt = call => {
  const user = call?.messages?.find(row => row.role === 'user')?.content || '';
  const match = user.match(/\[V5 THREAD CANDIDATES[^\]]*\]\n(\[[^\n]*\])/);
  return match ? JSON.parse(match[1]) : [];
};
const threadArtifact = ({ turn, threadEntityName, summary, status, link, resolution, alias, injectRuntimeFields = false }) => {
  const sourceRole = turn === 1 || turn === 10 ? 'assistant' : 'assistant';
  const value = {
    summary, status, kind: 'promise',
    participants: [
      { role: 'owner', personTempRef: 'jiho' },
      { role: 'target', personTempRef: 'mina' }
    ],
    ...(link ? { link } : {}),
    ...(resolution ? { resolution } : {}),
    ...(alias ? { linkCandidateAlias: alias } : {}),
    ...(injectRuntimeFields ? {
      participantIds: [{ role: 'owner', personId: 'provider_person_id' }],
      lifecycleId: 'provider_lifecycle_id',
      linkStatus: 'accepted',
      linkTarget: { schema: 'provider_target', factId: 'provider_fact', cursor: { key: 'provider_key' } }
    } : {})
  };
  return {
    schema: 'libra.canonical_artifact.v5',
    entities: [
      { tempId: 'mina', name: '민아', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
      { tempId: 'jiho', name: '지호', type: 'person', kind: 'person', evidenceSpans: [quote(turn, 'user')] },
      { tempId: 'thread', name: threadEntityName, type: 'world', kind: 'thread', evidenceSpans: [quote(turn, sourceRole)] }
    ],
    facts: [{
      tempFactId: `thread_fact_${turn}`, domain: 'narrative', subjectTempRef: 'thread',
      claimKind: 'thread', values: { thread: value },
      text: summary, temporalRole: 'current_sequence', certainty: 'confirmed',
      evidenceSpans: [quote(turn, sourceRole)]
    }]
  };
};

// Product mutation that this catches: remove closure delivery rows from the Classic renderer.
// Uses the registered hook, fresh runtimes, and persisted bytes; no source transforms.
const query = [{role:'user',content:'오늘 열쇠를 돌려주겠다는 약속은 어떻게 되었나요?'}];
const system = messages => messages.filter(x=>x.role==='system').map(x=>x.content).join('\n');
async function generated(summary='은빛 열쇠를 민아에게 돌려준 약속의 이행', initialPadding='',variant='') {
 const sourceChat=JSON.parse(JSON.stringify(chat));

 const f=await fixture({snapshot:{chat:sourceChat}});
 f.control.onCall=args=>{const result=f.control.calls.length===1
   ?threadArtifact({turn:1,threadEntityName:'오늘 열쇠 반환 약속',summary:'오늘 열쇠를 돌려주겠다는 약속'+initialPadding,status:'open'})
   :threadArtifact({turn:10,threadEntityName:'오늘 열쇠 반환 다짐',summary,status:'resolved',link:'resolve',resolution:'fulfilled',alias:candidateRowsFromPrompt(args[0])[0]?.alias});
 if(f.control.calls.length===2&&variant==='invalid_alias') result.facts[0].values.thread.linkCandidateAlias='foreign_request_alias';
 if(f.control.calls.length===2&&variant==='foreign_participants') result.facts[0].values.thread.participants=[{role:'owner',personTempRef:'mina'},{role:'target',personTempRef:'jiho'}];
 if(variant==='multi_fact') {
  const turn=f.control.calls.length===1?1:10;
  result.entities.push({tempId:'key',name:'열쇠',type:'world',kind:'object',evidenceSpans:[quote(turn,'user')]});
  for(const kind of ['ownership','possession']) result.facts.push({tempFactId:kind,domain:'world',subjectTempRef:'key',claimKind:kind,
   values:{[kind==='ownership'?'ownerRef':'holderRef']:turn===1?'jiho':'mina'},text:(turn===1?'지호':'민아')+'의 열쇠 '+kind,
   temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[quote(turn,'user')]});
 }
 if(variant==='projection_cap') {
  const turn=f.control.calls.length===1?1:10;
  for(let i=0;i<41;i++) result.facts.push({tempFactId:'p'+i,domain:'character',subjectTempRef:'mina',claimKind:'character_preference',
   values:{preferences:[{topic:'topic'+i,kind:'preference',content:turn===1?'old'+i:'new'+i}]},text:(turn===1?'old':'new')+i,
   temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[quote(turn,'user')]});
 }
 return {type:'success',result:JSON.stringify(result)};};
 assert.equal((await f.run()).completed,2);
 const settings=await f.r.api.getLibraMemorySettings();
 await f.r.api.saveLibraMemorySettings({...settings,recallMaxMemories:1,recallMaxChars:3000});
 return f;
}
module.exports={generated,fixture,query,system,rows,threadArtifact,candidateRowsFromPrompt};
