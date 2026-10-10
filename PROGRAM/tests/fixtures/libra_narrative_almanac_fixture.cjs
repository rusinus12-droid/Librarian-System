'use strict';
const {worldAtlasHead}=require('./libra_world_atlas_fixture.cjs');
function narrativeAlmanacHead(){
 const h=worldAtlasHead();const ev=(turn,quote)=>({memoryId:'sample-'+turn,revision:1,turnRange:{start:turn,end:turn},evidenceSpans:[{ref:'t'+turn+'-a',quote}]});
 const gate=ev(108,'“허가서가 없으면 통과시킬 수 없습니다.” 나는 닫힌 문 앞에서 멈췄다.');
 const lamp=ev(105,'다빈이 등불을 건넸다. “돌아오면 돌려줘.” 나는 고개를 끄덕였다.');
 h.domainStatus.narrative={status:'ready',throughTurn:110};
 h.narrative={summary:'북문 통행 허가를 기다리고 있다. 문밖 불빛의 주인은 아직 확인되지 않았으며, 다빈에게 빌린 등불을 돌려줘야 한다.',
 events:[{id:'gate',turn:108,text:'북문 경비가 평의회의 허가서를 요구했다.',evidence:gate},{id:'halt',turn:108,text:'허가서가 없어 북문을 통과하지 못했다.',evidence:gate},{id:'lamp',turn:105,text:'다빈에게 등불을 빌리고 반환을 약속했다.',evidence:lamp},{id:'light',turn:109,text:'문밖에서 불빛을 목격했지만 사람의 정체는 확인하지 못했다.',evidence:ev(109,'문틈 너머로 불빛이 움직였다. 그것을 든 사람의 얼굴은 보이지 않았다.')}],
 threads:[{id:'permit',summary:'북문 통행 허가 확인',kind:'task',status:'blocked',interpretation:'통행은 허가 여부에 달려 있다. 허가가 내려졌다는 기록은 아직 없다.',evidence:gate,updatedTurn:110,introducedTurn:108,arcId:'north'},
 {id:'light',summary:'문밖 불빛의 주인',kind:'question',status:'uncertain',interpretation:'불빛을 든 사람의 정체와 의도는 미확정이다.',evidence:ev(109,'그것을 든 사람의 얼굴은 보이지 않았다.')},
 {id:'lamp',summary:'빌린 등불 돌려주기',kind:'promise',status:'open',interpretation:'등불 반환 완료는 아직 확인되지 않았다.',evidence:lamp}],
 arcs:[{id:'north',title:'닫힌 북문 너머',summary:'등불을 빌려 북문으로 향했지만 허가 문제로 발걸음이 멈췄다.',status:'active',phase:'developing',centralPressure:'밖으로 나가려는 움직임과 통행 제한이 맞물려 있다.',firstTurn:105,lastTurn:110,participants:['dabin'],worldRefs:['village'],evidence:gate}],
 turningPoints:[{id:'halt',summary:'북문에서 통행이 중단되었다.',throughTurn:108,importance:'major',evidence:gate}],
 motifs:[{id:'light',summary:'어둠 속에서 반복된 빛의 이미지',count:2,lastTurn:109}],
 locks:[{id:'loan',summary:'등불은 선물이 아니라 대여품',status:'active',evidence:lamp},{id:'old',summary:'창고 열쇠 반환 전의 대여 관계',status:'released'}]};
 return h;
}
module.exports={narrativeAlmanacHead};
