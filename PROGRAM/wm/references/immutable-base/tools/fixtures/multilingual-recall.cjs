'use strict';
// Synthetic translations share a fact ID, not shared Latin entity labels.
// This is a reproducible diagnostic fixture, not a language proficiency benchmark.
const languages=['ko','en','ja','zh'];
const text={
  ko:{name:'민서',origin:'민서는 은문에서 어두운 터널을 건너다 다친 동료의 손을 잡아 주었다. 그 구조 사건 때문에 두 사람은 처음 서로 신뢰하게 되었다.',world:'민서는 시계탑의 종을 밤에 울리는 것이 금지라는 세계 규칙을 배웠다. 종소리가 잠든 수호자를 깨우기 때문이다.',recent:'민서는 최근 호숫가에서 가족과 소풍을 즐기고 꽃을 선물했다.',noise:'다른 주민은 정원에서 나무를 심고 평범한 작업 기록을 남겼다.',originQuery:'민서가 은문에서 처음 서로 신뢰하게 된 계기는 무엇이었지?',worldQuery:'민서가 시계탑의 종을 밤에 울리면 안 되는 세계 규칙은 무엇이지?',negative:'은문 구조 사건을 기억해 줘. 소풍은 제외해.',mixed:'민서 Silvergate 은문 구조 사건 기억',alias:'Minseo 은문 처음 신뢰 사건',unmapped:'Minseo Silvergate origin of their trust'},
  en:{name:'Minseo',origin:'Minseo held an injured companion by the hand while crossing the dark tunnel at Silvergate. This rescue was why they first began to trust each other.',world:'Minseo learned the world rule forbidding ringing the clocktower bell at night because its sound wakes the sleeping guardian.',recent:'Minseo recently enjoyed a family picnic beside the lake and gave flowers as a gift.',noise:'Another resident planted trees in a garden and wrote an ordinary work log.',originQuery:'Why did Minseo and the companion first begin to trust each other at Silvergate?',worldQuery:'What world rule forbids Minseo from ringing the clocktower bell at night?',negative:'Recall the Silvergate rescue, excluding the picnic.',mixed:'Minseo 은문 Silvergate rescue memory',alias:'민서 Silvergate first trust rescue',unmapped:'ミンソ 銀門 最初に信頼した理由'},
  ja:{name:'ミンソ',origin:'ミンソは銀門の暗いトンネルを渡る時、負傷した仲間の手を握って助けた。この救出事件をきっかけに二人は初めて互いを信頼した。',world:'ミンソは夜に時計塔の鐘を鳴らすことが禁止という世界の規則を知った。鐘の音が眠る守護者を起こすためだ。',recent:'ミンソは最近、湖のそばで家族とピクニックを楽しみ、花を贈った。',noise:'別の住民は庭で木を植えて通常の作業記録を残した。',originQuery:'ミンソが銀門で初めて互いを信頼したきっかけは何だった？',worldQuery:'ミンソが夜に時計塔の鐘を鳴らしてはいけない世界の規則は何？',negative:'銀門の救出事件を思い出して。ピクニックは除外して。',mixed:'ミンソ Silvergate 銀門 救出事件',alias:'Minseo 銀門 初めて信頼した事件',unmapped:'Minseo Silvergate origin of their trust'},
  zh:{name:'敏书',origin:'敏书穿过银门的黑暗隧道时，握住受伤同伴的手并救了他。这次救援事件使两人第一次开始互相信任。',world:'敏书了解到一条世界规则：夜间禁止敲响钟楼的钟，因为钟声会唤醒沉睡的守护者。',recent:'敏书最近与家人在湖边野餐，并赠送了鲜花。',noise:'另一位居民在花园种树并留下普通的工作记录。',originQuery:'敏书在银门第一次开始互相信任的原因是什么？',worldQuery:'敏书夜间不能敲响钟楼的钟，这是什么世界规则？',negative:'回忆银门的救援事件。排除野餐。',mixed:'敏书 Silvergate 银门 救援事件',alias:'Minseo 银门 第一次信任的事件',unmapped:'Minseo Silvergate origin of their trust'}
};
const make=(id,body,meta={})=>({key:id,comment:'lmai_memory',content:'[META:'+JSON.stringify({t:2,ttl:-1,imp:5,ent:[],...meta})+']\n'+body});
const distractors={
  ko:['민서는 시장에서 고장 난 나침반을 수리했다.','민서는 역에서 새 지도와 기차표를 받았다.','민서는 병원에서 약초 치료를 배웠다.','민서는 도서관에서 사라진 장부를 찾았다.','민서는 다리에서 경비원과 통행세를 협상했다.','민서는 공연장에서 노래를 연습했다.','민서는 폭풍을 피해 창고에 머물렀다.','민서는 등대에서 배의 도착을 기다렸다.'],
  en:['Minseo repaired a broken compass at the market.','Minseo received a new map and train ticket at the station.','Minseo learned herbal treatment at the hospital.','Minseo found a missing ledger in the library.','Minseo negotiated a toll with a guard on the bridge.','Minseo practiced a song at the theater.','Minseo sheltered from a storm in the warehouse.','Minseo waited for a ship to arrive at the lighthouse.'],
  ja:['ミンソは市場で壊れた羅針盤を修理した。','ミンソは駅で新しい地図と切符を受け取った。','ミンソは病院で薬草の治療を学んだ。','ミンソは図書館で消えた帳簿を見つけた。','ミンソは橋で警備員と通行料を交渉した。','ミンソは劇場で歌を練習した。','ミンソは嵐を避けて倉庫に泊まった。','ミンソは灯台で船の到着を待った。'],
  zh:['敏书在市场修好了损坏的指南针。','敏书在车站拿到了新地图和车票。','敏书在医院学习草药治疗。','敏书在图书馆找到了丢失的账本。','敏书在桥上与警卫协商过路费。','敏书在剧院练习唱歌。','敏书在仓库避开暴风雨。','敏书在灯塔等待船只到达。']
};
function corpus(language){
  const t=text[language];
  return [make('origin',t.origin,{ent:[t.name]}),make('world',t.world,{ent:[t.name]}),make('recent',t.recent,{t:39,ent:[t.name]}),
    ...Array.from({length:29},(_,i)=>make('noise-'+i,distractors[language][i%8]+' '+String(i+1),{t:i+3,imp:5,ent:[t.name]})),
    make('deleted',t.origin,{imp:10,hme:{rollbackTombstone:true,rollbackState:'candidate_deleted'}}),
    make('expired',t.origin,{imp:10,t:1,ttl:1})];
}
function queries(){
  const out=[];
  for(const memoryLanguage of languages){
    for(const queryLanguage of languages)out.push({id:`origin-${memoryLanguage}-${queryLanguage}`,memoryLanguage,queryLanguage,category:memoryLanguage===queryLanguage?'same_language':'cross_language',query:text[queryLanguage].originQuery,relevant:['origin']});
    for(const [kind,relevant] of [['world',['world']],['mixed',['origin']],['alias',['origin']],['unmapped',['origin']],['negative',['origin']],['reroll',['origin']]]){
      out.push({id:`${kind}-${memoryLanguage}`,memoryLanguage,queryLanguage:kind==='unmapped'?'transliteration':memoryLanguage,category:{world:'world_rule',mixed:'mixed_language',alias:'provided_entity_alias',unmapped:'unmapped_transliteration',negative:'explicit_negation',reroll:'worldline_reroll'}[kind],query:kind==='reroll'?text[memoryLanguage].originQuery:kind==='world'?text[memoryLanguage].worldQuery:text[memoryLanguage][kind],relevant,
        ...(kind==='negative'?{excluded:['recent']}:{}),...(kind==='alias'?{focusNames:[text[memoryLanguage].name,memoryLanguage==='en'?'민서':'Minseo']}:{}),...(kind==='reroll'?{reroll:true}:{})});
    }
  }
  return out;
}
module.exports={languages,text,corpus,queries,make};
module.exports.domainControls=()=>languages.map(language=>({id:'external-'+language,memoryLanguage:language,queryLanguage:language,category:'external_domain_control',supplementary:true,relevant:[],query:{ko:'오사카 맛집 여행만 알려 줘. 이전 이야기와 무관해.',en:'Osaka restaurants and sightseeing, unrelated to the previous story.',ja:'大阪の観光とレストラン。以前の物語とは無関係。',zh:'大阪的观光和餐厅，与先前的故事无关。'}[language]}));
