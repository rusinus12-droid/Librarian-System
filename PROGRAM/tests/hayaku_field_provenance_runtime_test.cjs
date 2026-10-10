'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHayakuRuntime,createValidPacket}=require('./fixtures/hayaku_runtime_harness.cjs');
const source=fs.readFileSync(path.join(__dirname,'../plugins/HAYAKU_Locator_Continuity.js'),'utf8');
const schema=vm.runInNewContext(source.match(/const PACKET_STRUCTURED_SCALAR_FIELDS = Object\.freeze\((\[[\s\S]*?\])\);/)[1]);
const blank=()=>{const p=createValidPacket();for(const a of ['entity','world','narrative','planner'])p[a]={};return p;};
(async()=>{const h=await createHayakuRuntime({autoRepair:false});try{
const t=h.hayaku._test,s={...h.hayaku.settings(),hierarchicalEpisodeMemoryEnabled:false},results=[];
for(const field of [...new Set([...schema,'personality_traits','description','profile'])]){
  // Identifiers are a different contract; this test varies payload fields only.
  if(['name','id','ref','publicRef','title','label','ownerEntityId','privacy','visibility','revealState','secrecyLevel','truthState','knowledgeState'].includes(field))continue;
  const st=t.emptyStore(),p=blank(),secret='Unshared indigo history';
  p.entity.characters=[{id:'owner',name:'Subject',privacy:'private',ownerEntityId:'owner',[field]:field==='profile'?{identity:secret}:secret},{id:'observer',name:'Observer'}];
  t.ingestPacket(st,JSON.stringify(p),'old-'+field,{messageIndex:1});
  const next=blank();next.entity.characters=[{id:'owner',name:'Subject',privacy:'public',location:'Open copper plaza'}];
  t.ingestPacket(st,JSON.stringify(next),'new-'+field,{messageIndex:3});
  const owner=st.entity.characters.find(r=>r.id==='owner');
  if(!owner)continue;
  const retained=Object.values(t.characterProjectionFields(owner)).some(v=>JSON.stringify(v).includes(secret));
  const disk=JSON.parse(JSON.stringify(st));t.rebuildIndex(disk,{settings:s,deadlineAt:Date.now()+5000});
  if(retained)assert(disk.index.some(r=>r.representation==='state_projection'&&r.publicText.includes(secret)&&r.visibility.privacy==='private'),'missing restricted projection: '+field);
  await t.localRecallPrepareSources([{raw:JSON.stringify(next),hash:'new-'+field,messageIndex:3}],disk,s,'fields-'+field,Date.now()+5000);
  const recall=async q=>t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(disk,q,s),q,s,14000).text;
  const denied=await recall('Observer '+secret); if(denied.includes(secret))console.log(JSON.stringify({field,denied,rows:disk.index.filter(r=>r.category==='character')})); assert(!denied.includes(secret),'private payload exposed: '+field);
  assert((await recall('Observer Open copper plaza')).includes('Open copper plaza'),'public update unavailable: '+field);
  if(retained)assert((await recall('Subject '+secret)).includes(secret),'owner lost retained value: '+field);
  results.push({field,retained});
}
assert(results.some(r=>r.field==='description'&&r.retained));
// An older merged store lacks the new ledger. Unknown origins may not inherit public visibility.
const legacy=t.emptyStore(),p=blank();p.entity.characters=[{id:'owner',name:'Subject',privacy:'private',ownerEntityId:'owner',description:'Legacy hidden token'},{id:'observer',name:'Observer'}];
t.ingestPacket(legacy,JSON.stringify(p),'legacy-old',{messageIndex:1});p.entity.characters=[{id:'owner',name:'Subject',privacy:'public',location:'Open copper plaza'}];t.ingestPacket(legacy,JSON.stringify(p),'legacy-new',{messageIndex:3});
delete legacy.entity.characters.find(r=>r.id==='owner')._characterStateProjection.fieldSources;
t.rebuildIndex(legacy,{settings:s,deadlineAt:Date.now()+5000});const q='Observer Legacy hidden token';
assert(!t.selectHayakuEvidencePlan(await t.searchIndexCompositeRecall(legacy,q,s),q,s,14000).text.includes('Legacy hidden token'));
assert(!source.includes('const axisWeights = query =>'));
console.log(JSON.stringify({cases:results.length,retained:results.filter(r=>r.retained).length,privateBlocked:true,publicPreserved:true,ownerAccessPreserved:true,legacyUnknownBlocked:true,modelCalls:h.llmCalls.length}));
}finally{await h.dispose();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

