'use strict';
// The publication validator and both collectors trace the same immutable tree.
module.exports = function forestReferences(value, prefix) {
  const fail=()=>{throw Error('LIBRA_GRAPH_FOREST_REFERENCE_CORRUPT');};
  const forest=ref=>{
    if(!ref||!/^[a-f0-9]{64}$/.test(ref.digest)||ref.key!==prefix+'forest:'+ref.digest)fail();
    return {...ref,type:'forest'};
  };
  if(value?.forest){
    if(value.forest.schema!=='libra.graph_corpus_forest.v1'||!Number.isSafeInteger(value.forest.shardCount)||value.forest.shardCount<1)fail();
    return [forest(value.forest.catalog),forest(value.forest.routes)];
  }
  if(value?.schema!=='libra.graph_corpus_forest_node.v1')return [];
  if(value.kind==='branch'){
    if(!value.children||Object.keys(value.children).length<1||Object.keys(value.children).length>16)fail();
    return Object.entries(value.children).map(([digit,ref])=>{if(!/^[a-f0-9]$/.test(digit))fail();return forest(ref);});
  }
  if(value.kind!=='leaf'||!Array.isArray(value.rows)||value.rows.length>32)fail();
  const refs=[];
  for(const row of value.rows){
    if(typeof row?.key!=='string'||!row.value)fail();
    const item=row.value;
    if(item.root!==undefined){
      let root;try{root=JSON.parse(item.root);}catch(_){fail();}
      if(root.schema!=='libra.graph_corpus.v1'||!/^[a-f0-9]{64}$/.test(root.digest)||root.manifestKey!==prefix+'manifest:'+root.digest)fail();
      refs.push({key:root.manifestKey,digest:root.digest,type:'manifest'},forest(item.routeKeys));
    }else if(item.shards){
      if(typeof item.term!=='string'||!Number.isSafeInteger(item.count)||item.count<1)fail();refs.push(forest(item.shards));
    }else if(typeof item.term!=='string'||!Number.isSafeInteger(item.start)||item.start<0)fail();
  }
  return refs;
};
