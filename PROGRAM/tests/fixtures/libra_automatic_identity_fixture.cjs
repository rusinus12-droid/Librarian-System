'use strict';
const {fixture,artifact}=require('./libra_unified_runtime_fixture.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function prepareAutomaticIdentityFixture(f){
 const base=clone(f.chat.message);
 f.chat.message.push(...base.map((row,i)=>({...row,chatId:`t${6+Math.floor(i/2)}-${i%2?'a':'u'}`,data:row.data.replaceAll('민아','김민아')})));
 const source='김민아는 민아와는 다른 사람이다. 김민아가 서재에 도착했다.';
 f.chat.message.find(row=>row.chatId==='t7-a').data=source;
 let calls=0;
 f.control.onCall=()=>{
  const a=artifact(),second=calls++>0;
  a.entities=a.entities.filter(e=>['mina','study'].includes(e.tempId));a.facts=a.facts.filter(row=>row.tempFactId==='f5');a.stateBindings=a.stateBindings.filter(row=>row.factTempId==='f5');
  if(second){
   for(const row of [...a.entities,...a.facts])for(const span of row.evidenceSpans){span.ref=span.ref.replace(/^t(\d+)/,(_,n)=>'t'+(Number(n)+5));span.quote=span.quote.replaceAll('민아','김민아');}
   const person=a.entities.find(e=>e.tempId==='mina');person.name='김민아';person.evidenceSpans=[{ref:'t7-a',quote:source}];
   a.facts[0].evidenceSpans=clone(person.evidenceSpans);a.facts[0].text='김민아가 서재에 도착했다.';
  }
  return {type:'success',result:JSON.stringify(a)};
 };
 return f;
}
async function automaticIdentityFixture(options={}){return prepareAutomaticIdentityFixture(await fixture(options));}
module.exports={automaticIdentityFixture,prepareAutomaticIdentityFixture};
