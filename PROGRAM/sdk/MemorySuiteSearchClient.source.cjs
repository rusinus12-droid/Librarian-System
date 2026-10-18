'use strict';
module.exports = function createMemorySuiteSearchClient(options) {
  const run=createMemorySuiteSearchKernel(), operation=options.namespace+'.memory-search.v1';
  const corpora=new Map(); let retainedBytes=0, disposed=false;
  // The compute server is loopback-only, so it shares this device's CPU. Measured
  // (docs/COMPUTE_SDK_ARRANGEMENT_20261017.md): cosine over 3000 vectors is 22 ms locally
  // and 2.8 s through the server; HAYAKU's warm local lexical index is 14 ms against
  // 480-575 ms remote. Neither kind is offloaded unless the owner opts in.
  const offload={vectors:false,lexical:false,...(options.offload||{})};
  const offloads=kind=>offload[kind]===true;
  const validate=(result,ctx)=>{
    const input=ctx.input, corpus=input.corpus;
    if(!corpus||result?.kind!==input.kind)return false;
    if(input.kind==='vectors')return Array.isArray(result.values)&&result.values.length===corpus.vectors.length
      &&result.values.every(row=>Array.isArray(row)&&row.length===input.queries.length&&row.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=1.000001));
    return Array.isArray(result.rankings)&&result.rankings.length===input.queries.length&&result.rankings.every(rows=>{
      const seen=new Set();
      return Array.isArray(rows)&&rows.every(row=>Number.isInteger(row.index)&&row.index>=0&&row.index<corpus.documents.length
        &&row.key===corpus.documents[row.index].key&&!seen.has(row.index)&&!!seen.add(row.index)
        &&Number.isFinite(row.score)&&row.score>0&&Number.isInteger(row.rank)&&row.rank>0);
    });
  };
  const bridge=createMemorySuiteComputeBridge({namespace:options.namespace,pluginId:options.pluginId,pluginVersion:options.pluginVersion,
    defaultMode:'local',defaultDeadlineMs:1500,localReserveMs:300,
    operations:{[operation]:{algorithmFingerprint:MEMORY_SUITE_SEARCH_FINGERPRINT,
      local:input=>run(input),validateResult:validate}}});
  const execute=async(input,scope,binding={},validateBinding=null)=>{
    if(disposed)throw Error('search_client_disposed');
    const policy=await options.storage.getScopeExecutionPolicy(scope,{force:false});
    if(disposed)throw Error('search_client_disposed');
    if(policy.computeMode==='local'||!offloads(input.kind))return run(input);
    // Keep the full immutable payload for local fallback. A reference is only a
    // transport optimization; it never selects or authorizes another snapshot.
    const full=JSON.parse(JSON.stringify(input)), serialized=JSON.stringify(full.corpus);
    const current=corpora.get(serialized);
    const request=current?{...full}:full;
    if(current){delete request.corpus;request.corpusId=current;}
    // The descriptor is per call so concurrent scopes cannot replace fallback data.
    const envelope=await bridge.execute({operation,input:full,mode:policy.computeMode,binding,validateBinding,
      transportInput:request});
    if(typeof envelope.result?.corpusId==='string' && !corpora.has(serialized)){
      while(corpora.size>=8 || retainedBytes+serialized.length*2>16*1024*1024){
        const first=corpora.keys().next().value;if(first===undefined)break;
        retainedBytes-=first.length*2;corpora.delete(first);
      }
      if(serialized.length*2<=16*1024*1024){corpora.set(serialized,envelope.result.corpusId);retainedBytes+=serialized.length*2;}
    }
    return envelope.result;
  };
  const vectors=async(vectors,queries,scope,binding={},validateBinding=null)=>{
    const unique=[...new Set(vectors.filter(Array.isArray))], qs=[...new Set(queries.filter(q=>Array.isArray(q)&&q.length))];
    if([...unique,...qs].some(vector=>vector.some(value=>typeof value!=='number'||!Number.isFinite(value))))throw Error('search_vector_non_finite');
    if(!offloads('vectors'))return (query,vector,fallback)=>fallback(query,vector);
    const started=Date.now();
    const scores=new Map();let offset=0;
    while(offset<unique.length&&qs.length){
      if(Date.now()-started>2500)break;
      let end=offset,cost=0,bytes=0;
      while(end<unique.length){const vector=unique[end],next=vector.length*qs.length,size=JSON.stringify(vector).length;
        if(end>offset&&(cost+next>400000||bytes+size>1500000))break;
        cost+=next;bytes+=size;end++;
      }
      const chunk=unique.slice(offset,end), snapshot=JSON.stringify([unique.slice(offset,end),qs]);
      const result=await execute({kind:'vectors',owner:options.namespace,corpus:{vectors:chunk},queries:qs},scope,binding,validateBinding);
      if(JSON.stringify([chunk,qs])!==snapshot)throw Error('search_vector_snapshot_changed');
      chunk.forEach((vector,index)=>scores.set(vector,new Map(qs.map((query,q)=>[query,result.values[index][q]]))));
      offset=end;
    }

    return (query,vector,fallback)=>scores.get(vector)?.get(query)??fallback(query,vector);
  };
  return {execute,vectors,offloads,status:bridge.status,dispose:async()=>{disposed=true;corpora.clear();retainedBytes=0;await bridge.dispose();}};
};
