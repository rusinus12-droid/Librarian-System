'use strict';
const crypto=require('node:crypto');
const hash=raw=>crypto.createHash('sha256').update(raw).digest('hex');
const prefix=scope=>'libra:v1:scope:'+scope+':memory-graph:v1:corpus:';
async function publish(store, n, {scope='test',root='r'+n, previous=null}={}) {
  const p=prefix(scope), lease=await store.acquire(scope,'build');
  const records=[];
  const add=(kind,value)=>{const raw=JSON.stringify(value),digest=hash(raw),key=p+kind+':'+digest;records.push({key,raw});return{key,digest};};
  const page=add('page:directory',[{id:n}]), proof=add('proof',{n});
  const data=add('projection',[{id:n}]);
  const parts=()=>Object.fromEntries(['nodes','edges','bases','units','canonicalRows'].map(key=>[key,{refs:[data]}]));
  const window=add('projection',{schema:'libra.graph_corpus_projection_window.v1',parts:parts()});
  const build=add('projection',{schema:'libra.graph_corpus_projection_build.v1',windows:[window]});
  const projection=add('projection',{schema:'libra.graph_corpus_projection.v2',parts:parts(),build});
  const vector=add('vector',['vector '+n]);
  const directory=add('semantic-directory',{schema:'libra.graph_semantic_directory.v1',entries:[{vectorPages:[vector]}]});
  const manifest=add('manifest',{schema:'libra.graph_corpus.v1',refs:[page],semanticDirectory:directory,
    sourceProofs:{proofKey:proof.key,proofDigest:proof.digest,projectionKey:projection.key,projectionDigest:projection.digest}});
  const key=p+'root:'+root,raw=JSON.stringify({schema:'libra.graph_corpus.v1',manifestKey:manifest.key,digest:manifest.digest});
  try {
    for(const record of records)await lease.putImmutable(record.key,record.raw);
    await lease.publish({key,raw,previous,manifestKey:manifest.key,manifestRaw:records.find(r=>r.key===manifest.key).raw});
  } finally {await lease.release();}
  return {key,raw,records,page,manifest};
}
module.exports={publish};
