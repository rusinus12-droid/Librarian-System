'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const families=['memory','entity','world','narrative'];
const key=x=>JSON.stringify([x.family,x.subtype,String(x.id)]);
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function stage(gold,items){
 if(!Array.isArray(items))throw new Error('stage_items_required');
 const units=new Map();for(const x of items){if(!families.includes(x.family)||!Array.isArray(x.roles))throw new Error('typed_item_contract');if(units.has(key(x)))throw new Error('duplicate_stage_identity');units.set(key(x),x);}
 const hit=gold.filter(g=>units.has(key(g))).length,roleCount=gold.reduce((n,g)=>n+g.roles.length,0);
 const roleHits=gold.reduce((n,g)=>n+g.roles.filter(role=>units.get(key(g))?.roles.includes(role)).length,0);
 const byType={};for(const family of families){const g=gold.filter(x=>x.family===family),i=items.filter(x=>x.family===family),h=g.filter(x=>units.has(key(x))).length;byType[family]={gold:g.length,returned:i.length,recall:g.length?h/g.length:null};}
 return {gold:gold.length,returned:items.length,hits:hit,recall:gold.length?hit/gold.length:null,precision:items.length?hit/items.length:null,
  roleRecall:roleCount?roleHits/roleCount:null,falsePositives:items.length-hit,abstained:items.length===0,byType};
}
function score(dataset,records){
 const oracle=new Map(dataset.cases.map(c=>[c.id,c]));if(oracle.size!==dataset.cases.length)throw new Error('duplicate_oracle_case');
 const seen=new Set(),cases=[];
 for(const record of records){if(seen.has(record.caseId))throw new Error('duplicate_record_case');seen.add(record.caseId);const c=oracle.get(record.caseId);if(!c)throw new Error('unknown_case');
  const stages={};for(const name of ['candidate','fusion','diversity','packing'])stages[name]=stage(c.gold,record.stages?.[name]);
  const baseline=record.baseline;if(!Array.isArray(baseline?.expected)||!Array.isArray(baseline?.present))throw new Error('baseline_evidence_required');
  cases.push({caseId:c.id,language:c.language,sourceLanguage:c.sourceLanguage||null,split:c.split,negativeKind:c.negativeKind||(!c.gold.length?'no_answer':null),stages,protectedCoreLost:baseline.expected.filter(k=>!baseline.present.includes(k)).length,
   safetyFailures:record.stages.packing.filter(item=>(dataset.forbidden||[]).some(word=>String(item.text||'').includes(word))).length,
   labels:record.labels||{},transport:record.transport||{},coverage:record.coverage||null,latency:record.latency||null});
 }
 // Completion is not quality. Live transport, reviewed frozen oracle, full
 // scenario coverage and host/model consumption evidence remain separate gates.
 return {schema:'libra.typed_recall.benchmark.v1',measurementCompleted:false,qualityVerdict:'unmeasured',productionEligible:false,
  oracleStatus:dataset.oracleStatus,cases,aggregates:aggregate(cases),distribution:distribution(dataset),missingCases:dataset.cases.filter(c=>!seen.has(c.id)).map(c=>c.id)};
}
function aggregate(cases){
 const reduce=(rows,family=null)=>{const stages={};for(const name of ['candidate','fusion','diversity','packing']){let gold=0,returned=0,hits=0;for(const row of rows){const s=family?row.stages[name].byType[family]:row.stages[name];gold+=s.gold;returned+=s.returned;hits+=s.hits??Math.round((s.recall||0)*s.gold);}stages[name]={gold,returned,hits,recall:gold?hits/gold:null,precision:returned?hits/returned:null,falsePositives:returned-hits};}return{cases:rows.length,...stages,protectedCoreLost:rows.reduce((n,x)=>n+x.protectedCoreLost,0),safetyFailures:rows.reduce((n,x)=>n+x.safetyFailures,0)};};
 return{byLanguage:Object.fromEntries([...new Set(cases.map(c=>c.language))].map(language=>[language,reduce(cases.filter(c=>c.language===language))])),
  byFamily:Object.fromEntries(families.map(f=>[f,reduce(cases,f)])),noAnswer:reduce(cases.filter(c=>c.negativeKind==='no_answer')),hardNegative:reduce(cases.filter(c=>c.negativeKind==='hard_negative'))};
}
function distribution(dataset){
 const result={total:dataset.cases.length,tuning:0,holdout:0,events:[],byLanguage:{},byFamily:Object.fromEntries(families.map(f=>[f,{positiveCases:0,directions:{}}]))};
 for(const c of dataset.cases){result[c.split]=(result[c.split]||0)+1;if(c.event&&c.event!=='negative'&&!result.events.includes(c.event))result.events.push(c.event);
  const l=result.byLanguage[c.language]||(result.byLanguage[c.language]={positive:0,hardNegative:0,noAnswer:0});if(c.gold.length)l.positive++;else if(c.negativeKind==='hard_negative')l.hardNegative++;else l.noAnswer++;
  for(const g of c.gold){const f=result.byFamily[g.family];f.positiveCases++;const direction=(g.sourceLanguage||c.sourceLanguage||'ko')+'->'+c.language;f.directions[direction]=(f.directions[direction]||0)+1;}
 }
 return result;
}
function arg(name){const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];}
if(require.main===module){try{const mode=arg('mode');if(!['baseline','replay'].includes(mode))throw new Error('mode_baseline_or_replay_required');const recordsPath=arg('records');if(!recordsPath)throw new Error('captured_records_required');
 const datasetPath=arg('dataset')||path.join(__dirname,'fixtures/typed-recall-measurement-v1.json'),dataBytes=fs.readFileSync(datasetPath),recordsBytes=fs.readFileSync(recordsPath),result=score(JSON.parse(dataBytes),JSON.parse(recordsBytes));
 result.mode=mode;result.datasetSha256=sha(dataBytes);result.recordsSha256=sha(recordsBytes);if(arg('dist'))result.bundleSha256=sha(fs.readFileSync(arg('dist')));
 const out=arg('out-root');if(!out)throw new Error('out_root_required');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'benchmark-'+mode+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({mode,cases:result.cases.length,qualityVerdict:result.qualityVerdict,realModelCalls:0}));
 }catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={score,stage,sha,aggregate,distribution};
