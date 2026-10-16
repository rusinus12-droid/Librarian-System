'use strict';
const crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const createPages=require('../../tools/libra_memory_graph_pages.cjs');
const createIndex=require('../../tools/libra_memory_graph_index.cjs');
const createCorpus=require('../../tools/libra_memory_graph_corpus.cjs');
const createLane=require('../../tools/libra_memory_graph_lane.cjs');
const createQuery=require('../../tools/libra_memory_graph_query.cjs');
const createCompiler=require('../../tools/libra_memory_graph_compiler.cjs');
const createRollout=require('../../tools/libra_memory_graph_rollout.cjs');
const createResources=require('../../tools/libra_memory_graph_resources.cjs');
function fixture(count=160,corpusOptions={}){
 const values=new Map(),reads=[],writes=[];let canceled=false,onRead=null;
 const graph={schema:'libra.memory_graph_projection.v1',scopeKey:'selective',
  readerFrame:{owner:'libra:plugin_only',scopeKey:'selective',worldlineId:'main',restoreEpoch:0,view:{viewerId:'owner_reader'}},
  nodes:[],edges:[],bases:[],units:[],coverage:{projectionComplete:true,families:{canonical:{records:count,reasons:[]}},
   inventory:{canonicalTotal:count,canonicalRead:count,microTurnTotal:0,canonicalNextCursor:'',microNextCursor:'',inventoryComplete:false}}};
 for(let i=0;i<count;i++){
  const n=String(i).padStart(4,'0'),sourceId='s'+n,nodeId='n'+n,basisId='b'+n;
  graph.nodes.push({id:sourceId,layer:'source',kind:'record',bindingId:'source'+n,identityCoverage:'revision_bound'},
   {id:nodeId,sourceId,layer:'meaning',kind:'canonical_fact',bindingId:'claim'+n,identityCoverage:'revision_bound'});
  graph.bases.push({id:basisId,sourceId,bindingId:'basis'+n,kind:'canonical_claim'});
  graph.edges.push({id:'e'+n,from:nodeId,to:sourceId,predicate:'evidenced_by',basisId,bindingId:'edge'+n,identityCoverage:'revision_bound'});
  graph.units.push({nodeId,recordKey:'memory'+n,family:'canonical',semanticRole:'canonical_assertion',text:'topic'+n+' archival evidence',turn:i+1});
 }
 const owner={check(){if(canceled)throw Error('OWNER_CANCELED');},async read(key){reads.push(key);await onRead?.(key);return values.get(key)??null;},
  async putImmutable(key,raw){values.set(key,raw);writes.push(key);},async publish({key,raw,previous,manifestKey,manifestRaw}){
   if((values.get(key)??null)!==previous||values.get(manifestKey)!==manifestRaw)throw Error('CONFLICT');values.set(key,raw);writes.push(key);}};
 const snapshot=async()=>({graph,collected:{scope:{scopeKey:graph.scopeKey},sourceKeys:[],canonicalRows:[]}});
 const environment=()=>{const pages=createPages({fingerprint:hash}),index=createIndex({pages,fingerprint:hash}),lane=createLane({index,pages}),query=createQuery({index,lane,pages,fingerprint:hash});
  const resources=createResources({measure:pages.measure,encodedSize:pages.encodedSize,stageCost:pages.stageCost});
  const compiler=createCompiler({fingerprint:hash}),rollout=createRollout({index,lane,query,compiler,pages,fingerprint:hash}),corpus=createCorpus({pages,index,fingerprint:hash,resources,...corpusOptions});return {pages,index,lane,query,compiler,rollout,corpus,resources};};
 let env=environment();
 const build=options=>env.corpus.build({snapshot,owner,options:{pageBytes:16384,...options}});
 const read=options=>env.corpus.read({initialGraph:graph,snapshot,owner,...options});
 const execute=async({eager=false,laneBudget={},queryText='topic0007'}={})=>{
  const corpus=await read({eager}),sealToken=env.rollout.sealRequestMode({mode:'unified',requestId:'test',...graph.readerFrame});
  const result=await env.rollout.executeUnifiedRequest({sealToken,graph:corpus.graph,preparedIndex:corpus.compiledIndex,
   queryInput:{queryText,maxHops:2},laneBudget,consumerPolicy:{maxUnits:64},
   ownerVerifier:{currentGraph:corpus.currentGraph,assertPhysicalCurrentness:async()=>{await corpus.assertIndexCurrent();return true;}}});
  return {corpus,result};
 };
 return {values,reads,writes,owner,snapshot,graph,build,read,execute,hash,get env(){return env;},restart(){env=environment();},cancel(){canceled=true;},onRead(fn){onRead=fn;},
  manifest(){const loc=env.corpus.location(graph),root=JSON.parse(values.get(loc.rootKey));return {loc,root,manifest:JSON.parse(values.get(root.manifestKey))};},
  replaceManifest(manifest){const {loc,root}=this.manifest(),raw=JSON.stringify(manifest),digest=hash(raw),manifestKey=loc.prefix+'manifest:'+digest;
   values.set(manifestKey,raw);values.set(loc.rootKey,JSON.stringify({...root,manifestKey,digest}));}};
}
module.exports={fixture};
