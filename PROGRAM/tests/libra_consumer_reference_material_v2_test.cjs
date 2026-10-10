'use strict';
const {assert,withHarness}=require('./fixtures/libra_consumer_test_support.cjs');
(async()=>{const results=[];const done=x=>{results.push(x);console.log('PASS '+x)};
await withHarness({},async(h,d,c)=>{
 d.character.globalLore=[{id:'lore-secret',key:'금고',comment:'금고',content:'금고의 암호는 민아만 알고 있다. 지호에게 비밀을 공개하지 않는다.',alwaysActive:true,mode:'normal'},{id:'lore-unused',key:'등대',comment:'등대',content:'먼 등대에는 파란 종이 있다.',mode:'normal'}];
 const p=await h.api.prepareInputWriterEvidence('금고를 살핀다.');assert.ok(p.evidencePacket.lore_prompt.includes('민아만 알고'));
 const readset=p.evidencePacket.consumer_read_set;assert.ok(readset.entries.some(e=>e.kind==='lore'));
 assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,true);
 d.character.globalLore[0].content+=' 암호가 바뀌었다.';
 assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,false);
 assert.equal(c.length,0);done('actual selected character lore is bound and reread without generation');
});
await withHarness({bootstrap_references_enabled:'true'},async(h,d,c)=>{
 d.db.personas=[{id:'persona-a',name:'기존 사용자',description:'PERSONA_USED 자신을 지호라 소개한다.'},{id:'persona-b',name:'새 사용자',description:'다른 사람이다.'}];d.chat.bindedPersona='persona-a';
 const p=await h.api.prepareInputWriterEvidence('자기 이름을 말한다.');assert.ok(p.evidencePacket.bootstrap_reference_prompt.includes('PERSONA_USED'));
 d.chat.bindedPersona='persona-b';assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,false);assert.equal(c.length,0);done('Risu-bound Persona selection change invalidates consumed bootstrap');
});
await withHarness({},async(h,d,c)=>{
 d.chat.note='';const p=await h.api.prepareInputWriterEvidence('금고를 본다.');d.chat.note='새로운 금지 지시';assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,false);done('enabled empty author note becoming nonempty is a selection-affecting change');
});
await withHarness({},async(h,d,c)=>{
 d.chat.note='{{user}}에게 암호를 공개하지 않는다.';d.db.personas=[{id:'persona-a',name:'지호',description:'한 명의 사용자'}];d.chat.bindedPersona='persona-a';
 const p=await h.api.prepareInputWriterEvidence('이유를 묻는다.');assert.ok(p.evidencePacket.author_note_prompt.includes('지호'));
 assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,true);
 d.db.personas[0].name='유진';assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,false);assert.equal(c.length,0);done('CBS-resolved author note pins the bound Persona data actually used');
});
await withHarness({},async(h,d,c)=>{
 const p=await h.api.prepareInputWriterEvidence('이유를 묻는다.');const config=await h.api.getLibraProviderConfig();
 await h.api.saveLibraProviderConfig({...config,inputWriterMode:'author'});
 assert.equal((await h.api.debugValidateInputWriterDeliverySnapshot(p.deliverySnapshot)).current,false);assert.equal(c.length,0);done('effective input-mode policy change invalidates prepared delivery without model');
});
console.log(JSON.stringify({test:'reference_material_v2',passed:results.length,results,externalModelCalls:0}));})().catch(e=>{console.error(e);process.exitCode=1;});
