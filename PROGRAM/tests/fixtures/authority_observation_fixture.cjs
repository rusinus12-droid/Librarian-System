'use strict';
const crypto=require('node:crypto');
const {core3Fixture}=require('./authority_core3_fixture.cjs');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const keyFor=(scope,start=1,revision=1)=>`libra:v1:scope:${scope}:memory:${start}:r${revision}`;
function observationFixture(t,{scopeKey='scopeA',text='A complete memory. 한글 😀\n\u0000end',mutateSeed}={}){
 const f=core3Fixture(t),db=f.databases.libra;
 f.scopeKey=scopeKey;f.key=keyFor(scopeKey);f.manifestKey=`libra:v1:scope:${scopeKey}:manifest`;
 f.memory={schema:'libra.canonical_memory.v1',scopeKey,memoryId:'mem1',revision:1,status:'committed',sourceDigest:'source1',turnRange:{start:1,end:5},text};
 f.manifest={schema:'libra.manifest.v1',scopeKey,characterId:'characterA',chatId:'chatA',worldlineMeta:{schema:'libra.worldline_meta.v1',scopeKey},branchGuard:{schema:'libra.branch_guard.v1',status:'ready',verifiedStarts:[1]},memories:{'1':{key:f.key,memoryId:'mem1',revision:1,sourceDigest:'source1',status:'committed',turnRange:{start:1,end:5}}}};
 f.seed=(key,value,{raw=JSON.stringify(JSON.stringify(value)),deleted=0,revision=1}={})=>db.prepare('INSERT OR REPLACE INTO kv VALUES(?,?,?,?,?,?,0)').run('plugin',key,raw,deleted,revision,hash(raw));
 f.seed(f.manifestKey,f.manifest);f.seed(f.key,f.memory);if(mutateSeed)mutateSeed(f);
 f.initialize();f.bind();f.initial=f.qualify().receipt;
 f.coordinator=require('../../server/authority/coordinator.cjs').createAuthorityCoordinator({control:f.control,resolveOwnerStore:n=>f.owners[n]});
 f.mutate=(key,value,{purge=false,deleted=0,namespace='libra'}={})=>{
  const operationId=crypto.randomUUID(),fingerprint=hash(operationId),raw=JSON.stringify(JSON.stringify(value));
  return f.coordinator.runMutation({namespace,operationId,fingerprint,operationClass:'kv'},tx=>{
   if(purge)tx.run('DELETE FROM kv WHERE space=? AND key=?','plugin',key);
   else tx.run('INSERT INTO kv VALUES(?,?,?, ?,1,?,0) ON CONFLICT(space,key) DO UPDATE SET value_json=excluded.value_json,deleted=excluded.deleted,revision=kv.revision+1,digest=excluded.digest','plugin',key,raw,deleted,hash(raw));
   tx.run('INSERT INTO operations VALUES(?,?,?,0)',operationId,fingerprint,'{"ok":true}');
  });
 };
 f.request=(requestId='request1')=>({namespace:'libra',requestId,scopeKey,starts:[1],durationMs:120000});
 return f;
}
module.exports={observationFixture,hash,keyFor};
