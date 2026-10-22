'use strict';
// GRADIA lorebook selection latency in the real draft pipeline (offline host, fake model).
// Runs the actual plugin with N synthetic, cross-referencing character lore entries and
// times each selection phase per turn (the first turn and the median of later turns).
//
// node --test-name-pattern=lore-bench PROGRAM/tools/rag_eval/gradia_lore_selection_bench.cjs
// Env: LORE_SIZES=100,500,1000,3000 (default 100,500,1000,3000,10000), RUNS=4.
// Needs the pinned dev dependencies (acorn) like the GRADIA tests.
const {test}=require('node:test');const path=require('node:path'),crypto=require('node:crypto');
const program=process.env.PROGRAM_DIR||path.resolve(__dirname,'../..');
const sizes=(process.env.LORE_SIZES||'100,500,1000,3000,10000').split(',').map(Number);
const acorn=require(path.join(program,'tools/gradia/load-dev-dependency.cjs'))('acorn');
const {fixture:legacyFixture}=require(path.join(program,'tests/gradia/evidence-bridge.test.cjs'));
const WRAP=['loadRisuStaticContextSnapshot','collectRisuLorebookCandidates','loadRisuContextSnapshot','buildContinuityEntityIndex',
 'reuseRisuSelectedLorebooks','buildGradiaSharedLoreCandidatePool','loreFullTextBm25fCorpusScores','buildShadowRisuContext','materializeSharedRisuContext'];
function wrapTimers(source){
 const ast=acorn.parse(source,{ecmaVersion:'latest'}),edits=[];
 (function walk(n){if(!n||typeof n!=='object')return;
  if(n.type==='VariableDeclarator'&&n.id?.type==='Identifier'&&WRAP.includes(n.id.name)&&n.init&&/Function/.test(n.init.type))edits.push({start:n.init.start,end:n.init.end,name:n.id.name});
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);})(ast);
 for(const e of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,e.start)+`globalThis.__loreTimer(${JSON.stringify(e.name)},${source.slice(e.start,e.end)})`+source.slice(e.end);
 return source;
}
const totals={};
globalThis.__loreTimer=(name,fn)=>function(...args){const t=performance.now();const done=()=>{const r=totals[name]||(totals[name]={ms:0,calls:0});r.ms+=performance.now()-t;r.calls++;};
 const out=fn.apply(this,args);if(out&&typeof out.then==='function')return out.finally(done);done();return out;};
const syl='가나다라마바사아자차카타파하';const word=i=>Array.from(String(i),d=>syl[Number(d)]).join('')+syl[i%14];
const KO='그는 오래된 서고의 규칙을 지키며 문지기와 약속을 나누었다. 밤이 되면 푸른 문이 열리고 기록은 다시 움직인다. ';
function lorebook(n){
 return Array.from({length:n},(_,i)=>{
  const kind=['인물','장소','세력','사건'][i%4],name=`${kind}${word(i)}`;
  const refs=[1,2,3].map(k=>`${['인물','장소','세력','사건'][(i+k)%4]}${word((i*7+k*13)%n)}`).join(', ');
  return {key:`${name}, ${word(i)}${i}`,secondkey:'',comment:name,mode:'normal',insertorder:100+(i%50),alwaysActive:i%97===0,selective:false,
   content:`${name}: ${KO.repeat(4+(i%6))}관련: ${refs}. 고유 표식 ${name}-${i}.`};
 });
}
const conversation=n=>{
 const mention=k=>`${['인물','장소','세력','사건'][k%4]}${word(k)}`;
 return [
  {role:'user',messageId:'u1',content:`${mention(7%n)}이 ${mention(12%n)}에 도착했다.`},
  {role:'assistant',messageId:'a1',generationInfo:{generationId:'g1'},content:`${mention(7%n)}은 ${mention(45%n)}의 문 앞에서 기다렸다. `+KO.repeat(6)},
  {role:'user',messageId:'u2',content:`${mention(7%n)}과 ${mention(301%n)}이 ${mention(12%n)}에서 만나는 장면을 이어서 써 줘.`}];
};
const pct=(arr,p)=>{const s=[...arr].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(p*s.length))];};
test('lore-bench',{timeout:3600000},async()=>{
 const rows=[];
 for(const n of sizes){
  const lore=lorebook(n);const character={chaId:'character-library',name:'Archivist',desc:'서고 관리인. '.repeat(40),personality:'Calm.',globalLore:lore,chats:[{id:'chat-evening',localLore:[]}],chatPage:0};
  const f=await legacyFixture({server:true,unbound:true,transform:wrapTimers,testGlobals:{crypto:crypto.webcrypto,__loreTimer:globalThis.__loreTimer,performance},expectedUrl:/^https:\/\/api\.openai\.com\//,api:{getCharacter:async()=>character}});
  f.settings.presets={offline:{provider:'openai',url:'https://api.openai.com/v1/chat/completions',key:'synthetic-only',model:'gpt-4o-mini-2024-07-18',request_format:'chat_completions',context_window:128000,max_tokens:4096,reasoning_preset:'off',reasoning_effort:'none',timeout_ms:1000,stream:false}};
  f.settings.defaultPresetName='offline';f.settings.stagePresetNames={};
  const runs=[];let meta=null;
  for(let r=0;r<Number(process.env.RUNS||4);r++){
   for(const k of Object.keys(totals))delete totals[k];
   const t0=performance.now();const res=await f.host.pipeline(conversation(n),'model',f.settings);const wall=performance.now()-t0;
   const rt=f.host.plugin.getRuntime();const pt=rt.pipelineTimings||{};
   meta=rt.lastRisuContext?.shared?.meta||meta;
   const stageMs=Object.values(pt.stages||{}).reduce((s,x)=>s+Number(x.contextMaterializeMs||0),0);
   runs.push({ok:res?.ok,wall,shared:Number(pt.sharedContext?.elapsedMs||0),stageMs,parts:JSON.parse(JSON.stringify(totals))});
  }
  const warm=runs.slice(1);
  const m=k=>pct(warm.map(x=>x.parts[k]?.ms||0),0.5).toFixed(1);
  rows.push({로어북:n,'첫 턴 선별 ms':(runs[0].shared+runs[0].stageMs).toFixed(0),'이후 선별 ms(중앙)':pct(warm.map(x=>x.shared+x.stageMs),0.5).toFixed(0),
   '스냅샷·스캔':m('loadRisuContextSnapshot'),'인물색인':m('buildContinuityEntityIndex'),'후보풀(BM25 등)':m('buildGradiaSharedLoreCandidatePool'),'단계뷰 4개':pct(warm.map(x=>x.stageMs),0.5).toFixed(1),'뷰 생성(전체)':m('materializeSharedRisuContext'),'뷰 호출수':warm[0].parts.materializeSharedRisuContext?.calls||0,
   '파이프라인 전체 ms':pct(warm.map(x=>x.wall),0.5).toFixed(0),'후보':meta?.loreCandidates??'?','선택':meta?.activeLore??'?',ok:runs.every(x=>x.ok)});
  console.log(JSON.stringify(rows.at(-1)));
 }
 console.table(rows);
});
