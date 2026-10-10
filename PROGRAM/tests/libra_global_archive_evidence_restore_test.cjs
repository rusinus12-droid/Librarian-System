'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.resolve(__dirname,'../plugins/LIBRA.js'),'utf8'),ctx=vm.createContext({console});
vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../sdk/MemorySuiteSourceReview.source.js'),'utf8'),ctx);
vm.runInContext('const LIBRA_SHARED_ARCHIVE_SCHEMA="libra.shared_archive.v1";const LibraMemoryCore={createSourceEvidenceStore:createMemorySuiteSourceEvidence};'+source.slice(source.indexOf('const memorySuiteLibraRestoreObject'),source.indexOf('async function memorySuiteLibraResolveRestoreDependencies'))+source.slice(source.indexOf('async function memorySuiteLibraValidateRestore'),source.indexOf('const MemorySuiteConfigStorageBridge =')),ctx);
(async()=>{for(const kind of ['valid','foreign_chat','unreferenced_archive','key_mismatch','tampered','ref_digest','ref_identity','ref_owner','memory_digest']){
 const map=new Map(),scope=kind==='foreign_chat'?'foreign':'archive:A',unit={key:'1',start:1,end:1,identity:'u+a@main',sourceDigest:'same',originalDigest:'same'};
 const store=ctx.createMemorySuiteSourceEvidence({owner:'libra',keyPrefix:s=>`libra:v1:scope:${s}:source-evidence:v1:`,read:async k=>map.get(k),write:async(k,v)=>{map.set(k,v);return true;}});
 const ref=await store.put(scope,unit,[{turn:1,userMessageId:'u',assistantMessageId:'a',userText:'user',assistantText:'assistant',userRaw:'user',assistantRaw:'assistant',rawAvailable:true}]);
 const active='libra:v1:scope:ACTIVE:manifest',archive='libra:v1:shared-archive:A:manifest',memory='libra:v1:shared-archive:A:memory:m:r1';
 map.set(active,{schema:'libra.manifest.v1',scopeKey:'ACTIVE',memories:{},inheritedMemories:[],...(kind!=='unreferenced_archive'?{archiveRef:{archiveId:'A',manifestKey:archive}}:{})});
 map.set(archive,{schema:'libra.shared_archive.v1',archiveId:'A',memoryRefs:[{key:memory,status:'committed'}]});map.set(memory,{schema:'libra.canonical_memory.v1',scopeKey:'archive:A',memoryId:'m',sourceDigest:'same',sourceEvidenceRef:{...ref}});
 if(kind==='key_mismatch'){map.set(ref.key+'bad',map.get(ref.key));map.delete(ref.key);}
 if(kind==='ref_digest')map.get(memory).sourceEvidenceRef.payloadDigest='wrong';
 if(kind==='ref_identity')map.get(memory).sourceEvidenceRef.identity='wrong';
 if(kind==='ref_owner')map.get(memory).sourceEvidenceRef.owner='foreign';
 if(kind==='memory_digest')map.get(memory).sourceDigest='wrong';
 if(kind==='tampered'){const data=JSON.parse(map.get(ref.key));data.payloadDigest='bad';map.set(ref.key,JSON.stringify(data));}
 const result=await ctx.memorySuiteLibraValidateRestore({phase:'complete',scope:{scopeKey:'ACTIVE'},serverCandidates:[...map.keys()].map(logicalKey=>({space:'plugin',logicalKey,route:{kind:logicalKey===active?'scope':'shared'}})),readback:async(_space,key)=>map.get(key)??null});
 assert.equal(result.ok,kind==='valid',kind+': '+JSON.stringify(result.errors));console.log('PASS '+kind);
}})().catch(e=>{console.error(e);process.exitCode=1;});
