'use strict';
// Synthetic data only: historical metadata shape, 32 buckets, 45 inline vectors.
const hash=value=>{let h=0x811c9dc5;for(let i=0;i<value.length;i++)h=Math.imul(h^value.charCodeAt(i),0x01000193);return (h>>>0).toString(36);};
const createBucketFixture=(scopeKey,identity={},legacyManifest={})=>{
 const counts=[7,16,2,1,0,0,0,1,0,3,0,0,2,2,1,0,0,0,1,1,0,1,1,1,0,0,0,2,1,0,1,1];
 const prefix=`vector_rag_memory:scope:${hash(scopeKey)}:`,records=[];
 const buckets=counts.map((count,shard)=>{
  const items=Array.from({length:count},()=>{
   const index=records.length,sourceType=index<4?'response':index<7?'character_description':index<39?'global_lorebook':'persona';
   const item={schema:'vector_rag_memory.record.v2',id:`vrm_fixture_${index}`,hash:`fixture_${index}`,sourceHash:`source_${index}`,sourceId:`source:${index}`,scopeKey,sourceType,autoStatic:index>=4,
    text:'durable',dim:1024,vector:Array.from({length:1024},(_,i)=>i===index?1:0),provider:'voyageai',model:'fixture',tokenEstimate:2};
   records.push(item);return item;
  });
  return [prefix+`records:bucket:v1:shard:${String(shard).padStart(4,'0')}`,JSON.stringify({version:1,storageMode:'bucketed_v1',shard,scopeKey,records:items})];
 });
 const byType={};for(const record of records){const stats=byType[record.sourceType]||={records:0,chars:0,tokens:0};stats.records++;stats.chars+=7;stats.tokens+=2;}
 const manifest={schema:'vector_rag_memory.scope_manifest.v2',version:2,scopeKey,storageHash:hash(scopeKey),...identity,
  count:45,shardCount:32,shardSummaries:[],nextId:840,commitId:'',externalRetirementVersion:1,
  stats:{recordTotal:45,charTotal:315,tokenTotal:90,byType},storageMode:'bucketed_v1',bucketVersion:1,
  bucketCount:32,bucketCounts:counts,bucketHashes:buckets.map(([,raw])=>hash(raw)),...legacyManifest};
 return {manifest,records,buckets,entries:[[prefix+'manifest:v2',JSON.stringify(manifest)],...buckets]};
};
module.exports={createBucketFixture};
