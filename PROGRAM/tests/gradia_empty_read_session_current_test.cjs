'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const hash=s=>{let h=0x811c9dc5;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),0x01000193);return(h>>>0).toString(36);};
const h64=s=>{let h=0xcbf29ce484222325n;for(let i=0;i<s.length;i++)h=BigInt.asUintN(64,(h^BigInt(s.charCodeAt(i)))*0x100000001b3n);return'h64'+h.toString(36);};
for(const owner of ['libra','hayaku','flashback'])test(`${owner}: absent and deleted roots produce reusable empty read sessions`,()=>{
 const scope={characterId:'c',chatId:'h',scopeKey:owner==='flashback'?`char:${hash('c')}|chat:${hash('h')}`:owner==='hayaku'?'chat_'+h64('c\nh'):'empty-libra'};
 let metadata;
 const repo={database:{exec(){}},getMetadata:()=>({...metadata}),get(){throw Error('empty scopes must not read payloads');}};
 const adapter=require(`../server/core/gradia-${owner}-read-session.cjs`).createReadSession({getRepository:()=>repo,dataInstanceId:'test-data',epochs:()=>({[owner]:0}),canRead:()=>true});
 for(const tombstone of [false,true]){
  metadata={exists:false,tombstone,revision:tombstone?2:0,digest:tombstone?'a'.repeat(64):'',updatedAt:tombstone?123:0,valueBytes:0};
  const session=adapter.capture({scope});
  assert.equal(session.items.length,0);
  assert.equal(adapter.current(session).current,true);
  metadata={...metadata,exists:true,tombstone:false,revision:3,digest:'b'.repeat(64),updatedAt:124};
  assert.equal(adapter.current(session).current,false,'new memory invalidates empty evidence');
  assert.throws(()=>adapter.current({...session,dependencies:session.dependencies.map(d=>({...d,tombstone:true,revision:0}))}),/dependencies_invalid/);
 }
});
