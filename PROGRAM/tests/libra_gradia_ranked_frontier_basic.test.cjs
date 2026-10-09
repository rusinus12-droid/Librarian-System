'use strict';
// Actual owner algorithms in an in-memory host; no production admission claim.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createLibraVmHarness}=require('./fixtures/libra_vm_harness.cjs');
async function fixture(){return createLibraVmHarness({}, {}, {
 transformSource:source=>source.replace('    const sentenceUnits = value => {',
 '    globalThis.__rankedTest = { shortlistRecallCatalog, normalizeSettings, buildQueryBundle, selectByMmr, memorySimilarity, gradiaRankedMetadata, scoreGradiaHydratedRows, gradiaRankedOwnerProfile, registry: EmbeddingProviderRegistry };\n    const sentenceUnits = value => {')
 .replace("        const MULTILINGUAL_PROBE_SCHEMA = 'libra.embedding_multilingual_probe.v1';",
 `        globalThis.__seedRankedCache = (raw, texts) => { const cfg = normalizeConfig(raw); for (const value of texts) rememberQueryCache(queryCacheKey(cfg, value, {}), { vector: [1, 0], provider: cfg.provider, model: cfg.model, dimensions: 2, profileId: profileFor({ ...cfg, dimensions: 2 }).profileId, normalized: true }); };\n        const MULTILINGUAL_PROBE_SCHEMA = 'libra.embedding_multilingual_probe.v1';`),
 contextGlobals:{setTimeout:()=>({unref(){}}),clearTimeout(){},setInterval:()=>({unref(){}}),clearInterval(){}}
});}

function corpus(count=100){const refs=Array.from({length:count},(_,i)=>({key:'memory-'+i,memoryId:'mem-'+i,revision:1,status:'committed',turnRange:{start:i*5+1,end:i*5+5},sessionEpoch:0}));return {manifest:{schema:'libra.manifest.v1',memories:Object.fromEntries(refs.map((r,i)=>[i,r])),inheritedMemories:[],branchGuard:{schema:'libra.branch_guard.v1',status:'ready',verifiedStarts:[]}},catalog:{schema:'libra.recall_catalog.v3',scopeKey:'s',entries:refs.map(ref=>({memoryKey:ref.key,turnRange:ref.turnRange,sessionEpoch:0,searchText:'shared relevant memory '+ref.memoryId,strongAnchorTokens:[],summary:'summary'}))}};}
const bundle=()=>({currentText:'shared relevant memory',sceneText:'',sparseText:'shared relevant memory',currentWeight:1,sceneWeight:0,queryType:'state',currentAnchors:{strong:[],weak:[]},sceneAnchors:{strong:[],weak:[]},pairs:Array.from({length:500},()=>({})),promptChars:0,promptPressure:'normal'});
test('explicit ranked profile exposes bounded 80-row metadata frontier while ordinary hydration remains 32',async()=>{const f=await fixture();try{
 const t=f.context.__rankedTest,{catalog,manifest}=corpus(),settings=t.normalizeSettings({performancePreset:'balanced',candidateLimit:80,recallMaxMemories:12,forceCurrentScene:false}),q=bundle();
 const ordinary=t.shortlistRecallCatalog(catalog,manifest,q,{},settings,null,[]);
 const ranked=t.shortlistRecallCatalog(catalog,manifest,q,{},settings,null,[],'gradia.ranked-metadata.v2');
 assert.equal(ordinary.refs.length,32);assert.equal(ranked.profile,'gradia.ranked-metadata.v2');assert.equal(ranked.refs.length,80);assert.equal(ranked.rows.length,80);assert.equal(ranked.frontierLimit,80);assert.equal(ranked.ordinaryHydrateLimit,32);assert.equal(ranked.authorityQualified,false);
 assert.equal(JSON.stringify(t.shortlistRecallCatalog(catalog,manifest,q,{},settings,null,[])),JSON.stringify(ordinary));
}finally{await f.cleanup();}});
test('ranked profile caps forced union at the existing preset and retains an explicit temporal anchor',async()=>{const f=await fixture();try{
 const t=f.context.__rankedTest,{catalog,manifest}=corpus(400),settings=t.normalizeSettings({performancePreset:'light',candidateLimit:40,recallMaxMemories:6,forceCurrentScene:false}),q=bundle();q.provenanceRescue={selected:catalog.entries.slice(0,75).map(e=>({memoryKey:e.memoryKey}))};q.currentText='turn 2000';q.sparseText='turn 2000';
 const ranked=t.shortlistRecallCatalog(catalog,manifest,q,{},settings,null,[],'gradia.ranked-metadata.v2');assert.equal(ranked.refs.length,40);assert.equal(new Set(ranked.refs.map(r=>r.key)).size,40);assert.equal(ranked.frontierLimit,40);
 if(ranked.temporalAnchor.status==='resolved')assert.ok(ranked.refs.some(ref=>ref.key===ranked.temporalAnchor.ref.key));
}finally{await f.cleanup();}});
test('cache-only registry lookup is cold/inflight unavailable without calling an embedder',async()=>{const f=await fixture();try{
 const t=f.context.__rankedTest;assert.equal(typeof t.registry.peekWarmQuery,'function');const before=t.registry.getQueryCacheStats();const result=t.registry.peekWarmQuery({provider:'openai',model:'text-embedding-3-small'},['same complete query'],{});assert.equal(result.status,'unavailable');assert.equal(result.reason,'query_cache_unavailable');assert.equal(JSON.stringify(t.registry.getQueryCacheStats()),JSON.stringify(before));
}finally{await f.cleanup();}});

test('owner ranked metadata refuses a cold cache and actual local scoring retains full bodies',async()=>{const f=await fixture();try{
 const t=f.context.__rankedTest,{catalog,manifest}=corpus(),settings=t.normalizeSettings({performancePreset:'balanced',candidateLimit:80,recallMaxMemories:12,forceCurrentScene:false,evidenceGate:false}),q=bundle();
 const cold=t.gradiaRankedMetadata({catalog,manifest,queryBundle:q,settings,embeddingConfig:{provider:'openai',model:'text-embedding-3-small'}});
 assert.equal(cold.status,'unavailable');assert.equal(cold.reason,'query_cache_unavailable');
 const body='shared relevant memory '+('full body '.repeat(200));
 const records=Array.from({length:60},(_,i)=>({id:'mem-'+i+':r1',memory:{memoryId:'mem-'+i,revision:1,status:'committed',text:body,turnRange:{start:i*5+1,end:i*5+5},sessionEpoch:0},vectorRecord:null,shortlistMeta:{forced:i===0,forcedReasons:i===0?['current_scene_tail']:[]}}));
 const rows=t.scoreGradiaHydratedRows(records,{queryBundle:q,settings,queryVectors:{current:null,scene:null,profileId:'',configHash:''}});
 assert.equal(rows.length,60);assert.equal(rows[0].memory.text,body);assert.ok(rows.every(row=>Number.isFinite(row.relevance)));
}finally{await f.cleanup();}});

test('warm private owner profile hydrates its 80-row preset with actual LIBRA scoring and no provider calls',async()=>{const f=await fixture();try{
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
 const load=(file,name)=>Function(fs.readFileSync(path.join(__dirname,'..',file),'utf8')+';return '+name)();
 const protocol=load('sdk/gradia/GradiaReadV2Protocol.source.js','createGradiaReadV2Protocol')({sha256:sha});
 const render=load('sdk/GradiaEvidenceRender.v2.source.js','createGradiaEvidenceRender')({protocol}),limits=protocol.validateLimits({});
 const credit=load('sdk/gradia/GradiaReadV2Credit.source.js','createGradiaReadV2Credit')({maxManagedBytes:limits.managedBytes,maxPhysicalReads:4});
 const t=f.context.__rankedTest,{catalog,manifest}=corpus(400),settings=t.normalizeSettings({performancePreset:'balanced',candidateLimit:80,recallMaxMemories:12,forceCurrentScene:false,evidenceGate:false}),q=bundle(),embeddingConfig={provider:'openai',model:'text-embedding-3-small'};
 q.pairs=Array.from({length:2000},()=>({}));f.context.__seedRankedCache(embeddingConfig,[q.currentText]);
 const before=JSON.stringify(t.registry.getQueryCacheStats());
 const metadata=t.gradiaRankedMetadata({catalog,manifest,queryBundle:q,settings,embeddingConfig});assert.equal(metadata.status,'available');assert.equal(metadata.refs.length,80);assert.equal(JSON.stringify(t.registry.getQueryCacheStats()),before);
 let reads=0;const body=ref=>'shared relevant memory '+ref.memoryId+' '+('entire text '.repeat(80));
 const vmCredit={...credit,reserve:raw=>credit.reserve({...raw}),beginPhysical:raw=>credit.beginPhysical({...raw})};
 const result=await t.gradiaRankedOwnerProfile.createCapture({protocol,render,digest:sha,credit:vmCredit,metadata,queryBundle:q,settings,limits,reader:{
 async assertCurrent(){return true;},async inspect(ref){const content=body(ref);return {narrativeBytes:Buffer.byteLength(content),serializedBytes:Buffer.byteLength(content)+500,proofBytes:100,contentHash:sha(content),profile:'libra.canonical.memory-text.v1',sourceHandle:ref.key,groupId:null};},
 async materialize(ref){reads++;return {itemId:ref.memoryId,content:body(ref),row:{id:ref.memoryId,memory:{...ref,text:body(ref),status:'committed'},vectorRecord:null,shortlistMeta:metadata.rows.find(row=>row.entry.memoryKey===ref.key)}};}
 }});
 assert.equal(reads,80);assert.equal(result.items.length,80);assert.ok(result.coverage.returnedEligibleBytes>8192);assert.equal(result.coverage.frontierExhausted,true);assert.equal(result.authorityQualified,false);result.release();assert.equal(credit.snapshot().managedBytes,0);
}finally{await f.cleanup();}});
