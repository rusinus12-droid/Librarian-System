'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {createFlashback}=require('./fixtures/embedding_contract_harness.cjs');
(async()=>{const h=await createFlashback(path.resolve(__dirname,'..'));try{
 const t=h.api._test,cfg=t.normalizeSettings({embeddingProvider:'voyageai',embeddingModel:'voyage-4-large',embeddingUrl:'https://api.voyageai.com/v1/embeddings',embeddingDimensions:0});
 const vector=Array(1024).fill(0);vector[0]=1;
 const r={id:'legacy',provider:'voyageai',model:'voyage-4-large',embeddingProfileId:'emb_1ffje3w',vector,sourceType:'response',text:'A brass key opens the cabinet.'};
 assert.equal(t.embeddingProfileId(cfg,1024),'emb_1pnfjj3');
 assert.equal(t.recordEmbeddingCompatibility(r,cfg,{dimensions:1024}).comparable,true);
 for(const patch of [{embeddingDocumentPrefix:'changed'},{embeddingModelRevision:'new'},{embeddingUrl:'https://elsewhere.invalid/v1/embeddings'}])assert.equal(t.recordEmbeddingCompatibility(r,{...cfg,...patch},{dimensions:1024}).comparable,false);
 assert.equal(t.recordEmbeddingCompatibility({...r,embeddingProfileId:'unknown'},cfg,{dimensions:1024}).comparable,false);
 assert.equal(t.recordEmbeddingCompatibility(r,cfg,{dimensions:512}).comparable,false);
 assert.doesNotThrow(()=>t.recordEmbeddingCompatibility({provider:'hash',model:'hash-3',vector:[1,0,0]},t.normalizeSettings({embeddingProvider:'hash'}),{dimensions:3}));
 const arms=await t.generateRecallCandidateArms({records:[r],queryText:'key',queryVector:vector,settings:cfg,context:{queryProvider:'voyageai',queryModel:'voyage-4-large',queryProfileId:t.embeddingProfileId(cfg,1024)}});
 assert.equal(arms.dense.length,1);
 const messages=[{role:'user',content:'Open the cabinet.',chatId:'user-real'}, {role:'user',content:'Formatting instructions appended by a module.'}];
 const resolved=t.resolveFlashbackCurrentTurn(messages);
 assert.equal(resolved.rawText,'Open the cabinet.');
 assert.equal(resolved.requestIndex,0);
 const wrapped=t.resolveFlashbackCurrentTurn([{role:'user',content:'<current_message>Open the cabinet.</current_message>'},messages[1]]);
 assert.equal(wrapped.rawText,'Open the cabinet.');
 const history=[{role:'user',chatId:'old-user',content:'Old request.'},{role:'assistant',chatId:'old-answer',content:'Old answer.'}];
 const cases=[
  [[{role:"user",content:"<current_message>Old request.</current_message>"},history[1],{role:"user",content:"New request."}],"New request."],
  [[...history,{role:'user',content:'New request.'}],'New request.'],
  [[...history,{role:'user',id:'new-user',content:'New request.'}],'New request.'],
  [[...history,{role:'user',chatId:'new-user',content:'New request.'},{role:'user',content:'Formatting instructions appended by a module.'}],'New request.'],
  [[...history,{role:'user',content:'<current_message>New request.</current_message>'},{role:'user',content:'Formatting instructions appended by a module.'}],'New request.'],
  [[...history,{role:'user',content:'Old request.'}],'Old request.']
 ];
 for(const [request,expected] of cases){const before=JSON.stringify(request),out=t.resolveFlashbackCurrentTurn(request);assert.equal(out.rawText,expected);assert.equal(out.requestIndex,history.length);assert.equal(JSON.stringify(request),before,'selection cannot mutate caller messages');}
 console.log('PASS exact shipped Voyage profile dense admission, foreign profiles rejected, hash provider, authoritative input ahead of appended prompt');
}finally{await h.cleanup();}})().catch(e=>{console.error(e);process.exitCode=1;});
