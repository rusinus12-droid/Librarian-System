'use strict';
const transformSource=source=>source.replace('const memoryStageEnabledForSettings =','globalThis.__reanalysisKindsCore=LibraMemoryCore;\n  const memoryStageEnabledForSettings =');
const select=(inventory,...keys)=>({...inventory,ranges:inventory.ranges.filter(row=>keys.includes(row.key))});
function microReply(args,label='새 미크로 기억'){
  const input=JSON.parse(args[0].messages.find(row=>row.role==='user').content),quote=input.assistant.text.slice(0,24);
  return {type:'success',result:JSON.stringify({schema:'libra.micro_producer_envelope.v1',personCandidates:{spans:[],relations:[]},micro:{schema:'libra.micro_memory.v1',...input.binding,claims:[{changeKind:'event',text:label,actor:'',target:'',temporalRole:'current',certainty:'confirmed',epistemicStatus:'observed',stateChangeType:'none',evidence:{role:'assistant',messageId:input.assistant.messageId,startOffset:0,endOffset:quote.length,exactQuote:quote}}]}})};
}
function lensReply(f,turn=1,label='렌즈 기억'){
  const quote=f.chat.message[(turn-1)*2+1].data.slice(0,24);
  return {type:'success',result:JSON.stringify({items:[{label:'사건',text:label,refs:['t'+turn+'-a'],quote}]})};
}
async function createLens(f,name='관점 렌즈'){
  return f.r.api.createLens({name,instruction:{goal:'원문에서 사건을 기록하세요.'},cadence:{mode:'every_n_batches',everyNBatches:100},evidenceMode:'strict'});
}
module.exports={microReply,lensReply,transformSource,select,createLens};
