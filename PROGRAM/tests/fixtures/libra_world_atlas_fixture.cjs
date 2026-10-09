'use strict';
// Synthetic State, never production chat data. IDs and refs exercise the production renderer.
function worldAtlasHead(){
 const evidence=(turn,quote)=>({memoryId:'sample-'+turn,revision:1,turnRange:{start:turn,end:turn},sourceDigest:'sample-only',evidenceSpans:[{ref:`t${turn}-a`,quote}]});
 const row=(id,name,kind,state,turn,quote)=>({id,name,kind,state,aliases:[],identityEvidence:evidence(turn,quote),fieldEvidence:Object.fromEntries(Object.keys(state).map(k=>[k,evidence(turn,quote)]))});
 return {schema:'libra.continuity_state.v2',throughTurn:110,unifiedApplied:{engineVersion:'libra.unified.v2',pending:[]},domainStatus:{world:{status:'ready',throughTurn:110}},
  world:[
   row('village','하나 마을','location',{description:'북쪽 숲의 남쪽 경계에 자리한 작은 마을. 하나 자치회가 공동 시설과 북문을 관리하며, 일몰 이후에는 북문의 일반 통행이 제한된다.',managerRef:'council',condition:'늦가을 · 북문 폐쇄',sceneTime:'일몰 이후'},110,'해가 지자 하나 자치회가 관리하는 하나 마을의 북문이 닫혔다.'),
   row('home','다빈의 집 거실','location',{description:'하나 마을 안에 있는 다빈의 집. 벽난로와 낮은 탁자가 있는 거실에서 손님을 맞이했다.',parentRef:'village',ownerRef:'dabin',condition:'벽난로에 불이 켜져 있음'},105,'다빈은 하나 마을의 자기 집 거실에 손님을 안내했다.'),
   row('council','하나 자치회','organization',{description:'마을의 공동 시설과 야간 출입을 관리하는 주민 조직.',condition:'야간 순찰 운영 중'},92,'하나 자치회가 북문 출입과 공동 시설을 관리한다.'),
   row('curfew','일몰 이후의 북문 통행','rule',{rule:{text:'일몰 이후 북문 일반 통행 제한',scopeRef:'village',exceptions:[{locationRef:'village',condition:'약초 채집자가 자치회의 등불을 소지함',effect:'북쪽 숲으로 통행 허용'}]}},92,'일몰 이후 북문 통행은 제한되지만, 자치회의 등불을 소지한 약초 채집자는 숲으로 나갈 수 있다.'),
   row('lantern','자치회의 등불','object',{description:'야간 약초 채집자가 사용하는 등불. 자치회 소유이며 현재 다빈에게 대여되어 있다.',ownerRef:'council',holderRef:'dabin'},92,'다빈이 하나 자치회의 등불을 빌렸다. 채집이 끝나면 돌려주기로 했다.'),
   row('weather','늦가을의 저녁 안개','environment',{condition:'북쪽 숲 입구에 옅은 안개가 관측됨',sceneTime:'일몰 이후'},110,'북문 너머로 안개가 내려앉았다.')
  ],
  characters:[row('dabin','다빈','person',{locationRef:'home'},105,'다빈은 자기 집 거실에 있다.'),row('seoyun','서윤','person',{affiliations:[{organizationRef:'council',role:'야간 순찰 담당',status:'member'}]},84,'서윤은 하나 자치회의 야간 순찰 담당이다.'),row('minho','민호','person',{affiliations:[{organizationRef:'council',role:'기록 담당',status:'former'}]},80,'민호는 자치회 기록 담당에서 물러났다.')],relationships:[],narrative:{events:[]}};
}
module.exports={worldAtlasHead};
