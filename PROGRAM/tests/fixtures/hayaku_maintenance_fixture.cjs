'use strict';
const {createValidPacket,hiddenPacketMessage}=require('./hayaku_runtime_harness.cjs');
const plain=value=>JSON.parse(JSON.stringify(value));
const quote=n=>`Alice completed workshop task ${n}.`;
const messages=(missing=[],count=3)=>Array.from({length:count},(_,i)=>{const n=i+1;return [
 {role:'user',chatId:'u'+n,data:`Please complete task ${n}.`},
 {role:'assistant',chatId:'a'+n,data:missing.includes(n)?quote(n):hiddenPacketMessage(quote(n),createValidPacket({turn:n,subject:'Alice',summary:quote(n)}))}
]}).flat();
function envelope(n){const packet=createValidPacket({turn:n,subject:'Alice',summary:quote(n)});packet.entity.characters=[{name:'Alice'}];packet.planner.continuity_locks=[quote(n)];const grounding=[];
 const walk=(value,path)=>{if(Array.isArray(value)){value.forEach((v,i)=>{if(v!=null&&(typeof v!=='string'||v.trim()))grounding.push({path:`${path}[${i}]`,source:'target',evidence:[quote(n)]});});return;}
 if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))walk(v,path?path+'.'+k:k);};
 for(const axis of ['entity','world','narrative','planner'])walk(packet[axis],axis);
 grounding.push({path:'meta.summary_memory.summary',source:'target',evidence:[quote(n)]});return {schema:'hayaku.native_repair_output.v1',packet,grounding};
}
function coldResponder(call){const prompt=call.messages.map(m=>m.content).join('\n'),units=[...prompt.matchAll(/\[UNIT ORDINAL (\d+) · TURN (\d+) · ([^\]]+)\]/g)];
 if(prompt.includes('[COLD START BATCH ENVELOPE'))return {type:'success',result:JSON.stringify({schema:'hayaku.native_cold_start_batch_output.v1',packets:units.map(m=>({unitOrdinal:Number(m[1]),...envelope(Number(m[2]))}))})};
 const target=prompt.split('[TARGET TURN]').at(-1).split('[CONTEXT ONLY')[0];
 return {type:'success',result:JSON.stringify(envelope(Number(units[0]?.[2]||target.match(/workshop task (\d+)/)?.[1]||1)))};
}

module.exports={plain,messages,envelope,coldResponder};
