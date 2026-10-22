'use strict';
// GRADIA skill router: does the dynamic top-K pick the skill a scene obviously needs?
// Ten scene types with an expected skill each, routed through the real router/compiler
// for all four draft stages. No model calls.
// node PROGRAM/tools/rag_eval/gradia_skill_router_eval.cjs        (Korean scenes)
// LANG_EN=1 node PROGRAM/tools/rag_eval/gradia_skill_router_eval.cjs  (English scenes)
const path=require('node:path');
const {load}=require(path.join(process.env.PROGRAM_DIR||path.resolve(__dirname,'../..'),'tests/gradia/host.cjs'));
const scenes=process.env.LANG_EN?[
 {name:'combat',expect:['physical-conflict'],input:'Mina draws her sword, blocks the charging knight\'s blade and counterattacks at his flank.',terminal:'The knight roared and swung his longsword. The blade flashed in the torchlight as their shadows tangled on the stone floor.'},
 {name:'romance',expect:['intimacy-scene-execution','relationship-state-shift'],input:'Mina carefully takes Junho\'s hand and, voice trembling, confesses the feelings she has hidden.',terminal:'Junho leaned against the window and quietly watched Mina. Less than a step separated them.'},
 {name:'comedy',expect:['comedic-scene-construction'],input:'Mina walks into the meeting acting serious, and nobody tells her a cat is sitting on her head.',terminal:'A heavy silence filled the meeting room. The manager adjusted his glasses and turned a page.'},
 {name:'interrogation',expect:['information-exchange','knowledge-access-boundary'],input:'Mina presses the informant about where the missing archivist was last seen.',terminal:'The informant fiddled with his glass and glanced around. "That story costs extra."'},
 {name:'aftermath',expect:['immediate-aftermath'],input:'After the explosion, ears ringing, Mina searches the collapsed walls for Junho.',terminal:'The ceiling came down with a roar. When the dust settled, everything went quiet.'},
 {name:'quiet interior',expect:['quiet-interior-beat'],input:'Back alone in her room, Mina turns the day over in her mind while watching the rain.',terminal:'After everyone left, the mansion fell silent. Only rain tapped the glass.'},
 {name:'new character',expect:['new-entity-introduction'],input:'The door opens and an unfamiliar traveler walks in, taking off a soaked cloak.',terminal:'The guests nursed their drinks. The fireplace crackled.'},
 {name:'court',expect:['institutional-procedure'],input:'In court, Mina asks the judge to admit evidence and begins examining the witness by procedure.',terminal:'The judge struck the gavel. "Counsel, proceed with the next step."'},
 {name:'decision',expect:['consequential-decision'],input:'Mina must choose right now: save the kingdom or rescue her brother.',terminal:'There was no time. The gate was falling, and her brother was trapped in the far tower.'},
 {name:'team action',expect:['multi-actor-coordination'],input:'Mina, Junho and Sua split roles: distract the guards and crack the vault.',terminal:'The three traded glances at the alley\'s end. Two guards held the main gate.'}]:[
 {name:'전투',expect:['physical-conflict'],input:'민아는 검을 뽑아 달려드는 기사의 칼날을 막아내고, 옆구리를 노려 반격한다.',terminal:'기사가 고함을 지르며 장검을 휘둘렀다. 칼날이 횃불 빛을 받아 번뜩였고, 돌바닥 위로 두 사람의 그림자가 엉켰다.'},
 {name:'로맨스/친밀',expect:['intimacy-scene-execution','relationship-state-shift'],input:'민아는 준호의 손을 조심스럽게 잡고, 떨리는 목소리로 그동안 숨겨온 마음을 고백한다.',terminal:'준호는 창가에 기대어 조용히 민아를 바라보았다. 둘 사이의 거리는 한 걸음도 되지 않았다.'},
 {name:'코미디',expect:['comedic-scene-construction'],input:'민아는 진지한 척 회의에 들어가지만, 머리에 고양이가 올라탄 채라는 걸 아무도 말해주지 않는다.',terminal:'회의실에는 무거운 침묵이 흘렀다. 부장은 안경을 고쳐 쓰며 서류를 넘겼다.'},
 {name:'정보 교환/심문',expect:['information-exchange','knowledge-access-boundary'],input:'민아는 정보원에게 실종된 기록관이 마지막으로 어디서 목격됐는지 캐묻는다.',terminal:'정보원은 술잔을 만지작거리며 주변을 살폈다. "그 얘길 하려면 돈이 좀 더 필요하겠는데."'},
 {name:'사건 직후/부상',expect:['immediate-aftermath'],input:'폭발이 끝난 뒤, 민아는 귀가 먹먹한 채 무너진 벽 사이에서 준호를 찾는다.',terminal:'굉음과 함께 천장이 무너져 내렸다. 먼지가 가라앉자 사방이 고요해졌다.'},
 {name:'조용한 내면',expect:['quiet-interior-beat'],input:'민아는 혼자 방에 돌아와 오늘 있었던 일을 곱씹으며 창밖의 비를 바라본다.',terminal:'모두가 떠난 뒤 저택은 조용해졌다. 빗소리만 유리창을 두드렸다.'},
 {name:'새 인물 등장',expect:['new-entity-introduction'],input:'문이 열리고 처음 보는 낯선 여행자가 젖은 망토를 벗으며 들어온다.',terminal:'여관의 손님들은 각자 술잔을 기울이고 있었다. 벽난로 불이 타닥거렸다.'},
 {name:'제도/재판',expect:['institutional-procedure'],input:'민아는 재판정에서 판사에게 증거 제출을 요청하고 절차에 따라 증인 신문을 시작한다.',terminal:'판사가 의사봉을 두드렸다. "변호인, 다음 절차를 진행하십시오."'},
 {name:'중대한 결정',expect:['consequential-decision'],input:'민아는 왕국을 지킬 것인지 동생을 구할 것인지, 지금 당장 하나를 선택해야 한다.',terminal:'시간이 없었다. 성문은 무너지고 있었고, 동생은 반대편 탑에 갇혀 있었다.'},
 {name:'여러 인물 협동',expect:['multi-actor-coordination'],input:'민아, 준호, 수아는 각자 역할을 나눠 경비병의 주의를 끌고 금고를 연다.',terminal:'세 사람은 골목 끝에서 서로 눈짓을 교환했다. 경비병 두 명이 정문을 지키고 있었다.'}];
(async()=>{
 const h=await load();const p=h.plugin;const stages=['shadow_act','aide_character','aide_world','aide_plot'];
 const rows=[];let hit=0,total=0;const picks={};let maxMs=0,sumMs=0,n=0;const sizes={base:[],selected:[]};
 for(const sc of scenes)for(const stage of stages){
  const t=performance.now();const r=p.debugRouteSkillsForStage(stage,{latestUser:sc.input,terminalVisibleScene:sc.terminal},stage==='shadow_act'?'':sc.terminal+' '+sc.input);const ms=performance.now()-t;maxMs=Math.max(maxMs,ms);sumMs+=ms;n++;
  const sel=(r.selected||[]).map(x=>x.id);sel.forEach(id=>picks[id]=(picks[id]||0)+1);
  const ok=sel.some(id=>sc.expect.includes(id));if(stage==='shadow_act'){total++;if(ok)hit++;}
  const comp=r.compiledExecution||'';const idx=comp.indexOf('COMPILED SELECTED SKILLS');sizes.base.push(idx>0?idx:comp.length);sizes.selected.push(idx>0?comp.length-idx:0);
  rows.push({scene:sc.name,stage,selected:sel.map((id,i)=>`${id}(${r.selected[i].relevance.toFixed(3)})`).join(', ')||'(none)',expectHit:ok});
 }
 for(const r of rows.filter(r=>r.stage==='shadow_act'))console.log(`${r.expectHit?'O':'X'} ${r.scene.padEnd(12)} SHADOW: ${r.selected}`);
 console.log('--- other stages, expected skill hit:',rows.filter(r=>r.stage!=='shadow_act'&&r.expectHit).length,'/',rows.filter(r=>r.stage!=='shadow_act').length);
 console.log('SHADOW expected skill in top-2:',hit,'/',total);
 console.log('selection frequency over all 40 routes:',JSON.stringify(Object.entries(picks).sort((a,b)=>b[1]-a[1])));
 const avg=a=>Math.round(a.reduce((x,y)=>x+y,0)/a.length);
 console.log('compiled block chars — baseline avg',avg(sizes.base),'selected avg',avg(sizes.selected));
 console.log('route time ms — avg',(sumMs/n).toFixed(1),'max',maxMs.toFixed(1));
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
