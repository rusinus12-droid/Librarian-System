'use strict';
// Counterexamples from the external review; exercise production validators and
// collect each result so the baseline demonstrates all independent gaps.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(process.env.LIBRA_TEST_PLUGIN||path.join(__dirname,'../plugins/LIBRA.js'),'utf8');
const failures=[];function check(name,fn){try{fn();console.log('PASS',name);}catch(e){failures.push({name,error:e.message});}}
const ctx=vm.createContext({string:x=>String(x??''),asArray:x=>Array.isArray(x)?x:[],asObject:x=>x&&typeof x==='object'?x:{},
 canonicalEvidenceComparable:x=>String(x??'').normalize('NFKC').replace(/\s+/g,' ').trim(),
 canonicalEvidenceSpanBinding:(s,r)=>r?.raw.includes(s.quote)?s:null,explicitSourceColorObservations:()=>[],
 clone:x=>JSON.parse(JSON.stringify(x)),digest:x=>JSON.stringify(x),isPlainObject:x=>x&&typeof x==='object'&&!Array.isArray(x),
 UNIFIED_ARTIFACT_SCHEMA_V5:'libra.canonical_artifact.v5',UNIFIED_THREAD_ACTIVE_STATUS:['open','blocked','uncertain'],LIBRARIAN_STAGE_ID:'test',
 CANONICAL_ENTITY_KOREAN_PARTICLE:/^(?:에게|한테|께서|에서|으로|처럼|은|는|이|가|을|를|의|와|과|도|에)(?=$|[^\p{L}\p{N}_])/u,
 providerOutputWasTruncated:()=>false,parseCanonicalArtifactJson:JSON.parse,
 callMemoryProvider:async()=>({ok:true,content:JSON.stringify({repairs:[{factTempId:'incoming',decision:'new',evidenceRef:'t6-u',quote:'민아는 학교 등교 여부 확인 전화를 하기로 했다.'}]})}),
 canonicalizeUnifiedThreadLifecycle:({artifact,factIds})=>{for(const f of artifact.facts)if(factIds.has(f.tempFactId)){f.values.thread.linkStatus='new';f.values.thread.lifecycleId='new';}}
});
const evaluate=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a,start);vm.runInContext(source.slice(a,b),ctx);};
if(source.includes('    const sourceNamedPersonMentions ='))evaluate('    const sourceNamedPersonMentions =','    const explicitSourceColorObservations =');
evaluate('    const unifiedContextLocation =','    const normalizeUnifiedContextPlaces =');
evaluate('    const unifiedAppearancePairs =','    const quarantineUnifiedProviderRecords =');
evaluate('    const unifiedThreadAnchorTokens =','    const unifiedThreadParticipants =');
if(source.includes('    const unifiedThreadRepairNewConflict ='))evaluate('    const unifiedThreadRepairNewConflict =','    const repairUnifiedThreadLinks =');
evaluate('    const repairUnifiedThreadLinks =','    const unifiedPromptContract =');
vm.runInContext('globalThis.api={location:unifiedContextLocation,pairs:unifiedAppearancePairs,supported:unifiedAppearancePairSupported,repair:repairUnifiedThreadLinks}',ctx);
if(source.includes('    const sourceNamedPersonMentions =')){
 vm.runInContext('globalThis.api.mentions=sourceNamedPersonMentions',ctx);
 check('name offsets retain leading whitespace used by colour completion',()=>assert.equal(ctx.api.mentions('  민아의 ',[{name:'민아'}])[0].at,2));
}
const room={id:'room',type:'world',kind:'location',name:'좁은 방',validated:true},factory={...room,id:'factory',name:'폐공장'};
const head={characters:[{name:'민아',state:{locationRef:'room'}}]},registry={entities:[room,factory]};
check('deictic must not override an explicit new place without movement verbs',()=>assert.equal(ctx.api.location('이곳','민아는 폐공장 앞에 서 있다. 이곳은 어둡다.',registry,head),null));
check('unregistered explicit place also blocks old-place binding',()=>assert.equal(ctx.api.location('그곳','민아는 창고 앞에 서 있다. 그곳은 어둡다.',registry,head),null));
check('a bare deictic has no independently verified antecedent',()=>assert.equal(ctx.api.location('이곳','민아는 이곳에서 기다린다.',registry,head),null));
check('generic room must not hide another explicit place',()=>assert.equal(ctx.api.location('방','민아는 폐공장의 방에 서 있다.',registry,head),null));
check('explicit same-place antecedent remains usable',()=>assert.equal(ctx.api.location('이곳','민아는 좁은 방에 있다. 이곳은 어둡다.',registry,head)?.id,'room'));
const people=new Map([['short',{tempId:'short',name:'민아',type:'person'}],['full',{tempId:'full',name:'김민아',type:'person'}]]);
const proof=(subject,quote)=>({f:{subjectTempRef:subject,evidenceSpans:[{ref:'t6-u',quote}]},sources:new Map([['t6-u',{raw:quote}]])});
check('blond shorthand is an appearance attribute, not an unchecked word',()=>assert.ok(ctx.api.pairs('금발 머리').some(p=>p.key)));
check('a colour present nowhere in this quote cannot be borrowed',()=>{const p=ctx.api.pairs('금발 머리');assert.ok(p.length);const {f,sources}=proof('short','민아는 머리카락을 만졌다.');assert.equal(ctx.api.supported(p[0],f,people,sources),false);});
check('a short name inside a different full name is not an owner',()=>{const {f,sources}=proof('short','김민아는 붉은 눈을 지녔다.');assert.equal(ctx.api.supported(ctx.api.pairs('붉은 눈')[0],f,people,sources),false);});
check('the full-name owner retains its own quoted attribute',()=>{const {f,sources}=proof('full','김민아는 붉은 눈을 지녔다.');assert.equal(ctx.api.supported(ctx.api.pairs('붉은 눈')[0],f,people,sources),true);});
(async()=>{
 const ids=[{role:'owner',personId:'p1'},{role:'target',personId:'p2'}],quote='민아는 학교 등교 여부 확인 전화를 하기로 했다.';
 const value={summary:'학교 등교 여부 확인 전화',kind:'task',status:'open',participants:[{role:'owner',personTempRef:'p1'},{role:'target',personTempRef:'p2'}],participantIds:ids,link:'reaffirm',linkStatus:'pending',linkPendingReason:'candidate_status_disallows_link'};
 const artifact={schema:'libra.canonical_artifact.v5',entities:[{tempId:'p1',name:'민아'},{tempId:'p2',name:'준호'}],facts:[{tempFactId:'incoming',claimKind:'thread',domain:'narrative',certainty:'confirmed',temporalRole:'current_sequence',text:quote,evidenceSpans:[{ref:'t6-u',quote}],values:{thread:value}}]};
 const c={alias:'old',value:{summary:'학교에 전화해 등교 여부를 확인하는 일',kind:'task',status:'resolved'},participantIds:ids,participants:[{name:'민아'},{name:'준호'}]};
 await ctx.api.repair(artifact,[],{}, {diagnostics:{partial:false},candidates:[c],byAlias:new Map([['old',c]])});
 check('paraphrasing a known same-party task does not permit a new lifecycle',()=>assert.equal(artifact.facts[0].values.thread.linkStatus,'pending'));
 if(failures.length){console.error(JSON.stringify({failures},null,2));process.exitCode=1;}
})().catch(e=>{console.error(e);process.exitCode=1;});
