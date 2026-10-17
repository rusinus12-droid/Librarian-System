const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const root=require('node:path').join(__dirname,'../tools/');
const fp=text=>crypto.createHash('sha256').update(text).digest('hex'),digest=value=>fp(JSON.stringify(value));
const createPages=require(root+'libra_memory_graph_pages.cjs'),createIndex=require(root+'libra_memory_graph_index.cjs'),createLane=require(root+'libra_memory_graph_lane.cjs'),createQuery=require(root+'libra_memory_graph_query.cjs');
const dimension=1024,unit=axis=>Array.from({length:dimension},(_,i)=>i===axis?1:0);
const profile={provider:'fixture',model:'model',profileId:'profile',queryTask:'search_query',documentTask:'search_document',descriptor:{spaceId:'space',dimension,taskPair:'search_query/search_document'}};
const graph={schema:'libra.memory_graph_projection.v1',scopeKey:'scope',readerFrame:{owner:'libra:plugin_only',scopeKey:'scope',worldlineId:'main',restoreEpoch:0,view:{viewerId:'owner_reader'}},coverage:{},nodes:[],units:[],edges:[],bases:[]};
const rows=[],records=new Map();
for(let i=0;i<30;i++){
 const id=String(i).padStart(2,'0'),source='source-'+id,node='fact-'+id,key='micro-'+id,vectorKey='vector-'+id;
 graph.nodes.push({id:source,bindingId:source,layer:'source',identityCoverage:'revision_bound'},{id:node,bindingId:node,layer:'meaning',sourceId:source,identityCoverage:'revision_bound'});
 graph.units.push({nodeId:node,recordKey:key,family:'micro',semanticRole:'micro_candidate',turn:i+1,text:'stored assertion '+id});
 graph.bases.push({id:'basis-'+id,bindingId:'basis-'+id,sourceId:source});
 graph.edges.push({id:'edge-'+id,bindingId:'edge-'+id,from:node,to:source,predicate:'evidenced_by',basisId:'basis-'+id,identityCoverage:'revision_bound'});
 rows.push({family:'micro',nodeId:source,recordKey:key,vectorKey,textHash:id,spaceDigest:'space',dimensions:dimension,temporalEndTurn:i+1});
 records.set(vectorKey,{schema:'libra.micro_vector.v1',scopeKey:'scope',textHash:id,spaceDigest:'space',dimensions:dimension,provider:profile.provider,model:profile.model,profileId:profile.profileId,vector:unit(i===29?0:1)});
}
async function run(recover){
 const pages=createPages({fingerprint:fp}),index=createIndex({pages,fingerprint:fp}),lane=createLane({pages,index}),query=createQuery({pages,index,lane,fingerprint:fp});
 const createSemantic=require(root+'libra_memory_graph_semantic.cjs');
 const semantic=createSemantic({digest,profileFor:()=>profile,projectionFor:()=>{throw Error('not canonical');}});
 const readKeys=[];
 let calls=0,queryPromise;
 const embedQuery=()=>queryPromise||(queryPromise=Promise.resolve().then(()=>{calls++;return {provider:profile.provider,model:profile.model,dimensions:dimension,vectors:[unit(0)],metadata:{profileId:profile.profileId,requestCount:1}};}));
 const options={graph,canonicalRows:[],config:{enabled:true},queryText:'unrelatedvocabulary',maxBytes:262144,additionalRepresentations:rows,pages,fingerprint:fp,evaluate:query.evaluateRepresentation,
   readVector:async key=>{readKeys.push(key);return records.get(key);},embedQuery};
 const selection=recover?await semantic.selectAdditionalRepresentations(options):null;
 if(selection){assert.equal(selection.diagnostics.scanned,30);assert.equal(selection.references[0].nodeId,'source-29');assert.equal(selection.references.length,8);}
 const prepared=await semantic.prepareLazy({...options,additionalRepresentations:selection?.references||rows});
 const partition='p',generation=pages.generation(graph,{partition,restoreEpoch:0,view:graph.readerFrame}),compiled=index.withSemanticReader(index.compile(graph,{partition,generation}),prepared.readPage);
 const frame=query.sealQueryFrame({...prepared.queryInput,queryText:'unrelatedvocabulary',owner:graph.readerFrame.owner,scopeKey:'scope',worldlineId:'main'}),view=query.openView(graph,compiled,frame);
 try{const result=await query.retrieveAsync(view,{maxPages:128,maxBytes:524288,maxStoragePages:128,maxStorageBytes:1048576});return {recover,calls,foundTarget:result.candidates.some(c=>c.nodeId==='fact-29'),candidates:result.candidates.map(c=>c.nodeId),complete:result.complete,stopReason:result.stopReason,admitted:prepared.diagnostics.admittedRepresentations,ownerReads:readKeys.length,targetRead:readKeys.includes('vector-29'),representationBytes:prepared.diagnostics.representationBytes};}
 finally{query.closeView(view);}
}
(async()=>{
 const regressed=await run(false),recovered=await run(true);
 assert.equal(regressed.foundTarget,false);assert.equal(regressed.complete,false);
 assert.equal(recovered.foundTarget,true);assert.equal(recovered.complete,true);assert.equal(recovered.calls,1);
 assert.equal(recovered.admitted,8);assert.equal(recovered.representationBytes,92160);
 console.log(JSON.stringify({regressed,recovered},null,2));
 // Selection is not authority: changing a winner before the lane reads it must reject.
 const semantic=require(root+'libra_memory_graph_semantic.cjs')({digest,profileFor:()=>profile,projectionFor:()=>({})});
 const options={graph,config:{enabled:true},queryText:'query',additionalRepresentations:rows,readVector:async key=>records.get(key),
 embedQuery:async()=>({provider:profile.provider,model:profile.model,dimensions:dimension,vectors:[unit(0)],metadata:{profileId:profile.profileId}})};
 const selected=await semantic.selectAdditionalRepresentations(options);
 const reversed=await semantic.selectAdditionalRepresentations({...options,additionalRepresentations:[...rows].reverse()});
 assert.deepEqual(reversed.references.map(row=>row.nodeId),selected.references.map(row=>row.nodeId),'registration order must not change exact top-8');
 let active=0,peak=0;
 const resources={scope(){active++;peak=Math.max(peak,active);return {retain(){},close(){active--;}};}};
 await semantic.selectAdditionalRepresentations({...options,resources});
 assert.equal(active,0);assert.equal(peak,1,'scan releases each vector workspace before reading the next');
 await assert.rejects(()=>semantic.selectAdditionalRepresentations({...options,resources,readVector:async()=>{throw Error('source budget');}}),/source budget/);
 assert.equal(active,0,'failure also releases the scan workspace');
 records.get('vector-29').vector=unit(1);
 await assert.rejects(()=>semantic.prepare({...options,additionalRepresentations:selected.references}),/LIBRA_GRAPH_SEMANTIC_VECTOR_CHANGED/);
 console.log('PASS exact top-8 recovery, single query embedding, winner currentness');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
