'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../plugins/LIA_Persona_Linker.js'),'utf8');
const begin=source.indexOf('  let loreLimitSaveInFlight = false;'),end=source.indexOf('  function getRuntimeApi()',begin);assert.ok(begin>0&&end>begin);
function harness(initial='620',options={}) {
  let value=initial,reads=0,writes=[];
  const api={async getArgument(){reads++;if(options.readFailure)throw Error('read_failure');return value;},async setArgument(key,next){writes.push(next);if(options.write) return await options.write({next,writes,set:v=>value=v});value=next;return true;}};
  const ctx=vm.createContext({api});vm.runInContext(source.slice(begin,end)+'\nglobalThis.save=saveLoreCharacterLimit;',ctx);
  return {save:ctx.save,api,value:()=>value,writes,reads:()=>reads};
}
(async()=>{
  let h=harness();assert.equal(await h.save('740'),740);assert.equal(h.value(),'740');assert.equal(h.reads(),2);
  for(const value of ['',239,3001,740.5,'NaN']){h=harness();await assert.rejects(h.save(value));assert.equal(h.writes.length,0);}
  h=harness('620',{readFailure:true});await assert.rejects(h.save(740),/read_failure/);assert.equal(h.writes.length,0);
  h=harness('620',{write:({next,writes,set})=>{if(writes.length===1)return true;set(next);return true;}});await assert.rejects(h.save(740),/재읽기/);assert.equal(h.value(),'620');assert.deepEqual(h.writes,['740','620']);
  h=harness('620',{write:({next,writes,set})=>{set(next);if(writes.length===1)throw Error('ambiguous_write');return true;}});await assert.rejects(h.save(740),/ambiguous_write/);assert.equal(h.value(),'620');
  h=harness('620',{write:({writes,set})=>{if(writes.length===1){set('unexpected');throw Error('write_failure');}return true;}});await assert.rejects(h.save(740),e=>e.code==='LIA_LORE_LIMIT_ROLLBACK_INCOMPLETE');assert.equal(h.value(),'unexpected');
  h=harness('',{write:({next,writes,set})=>{if(writes.length===1)return false;set(next);return true;}});await assert.rejects(h.save(740),/거절/);assert.equal(h.value(),'');
  let release;h=harness('620',{write:async({next,set})=>{await new Promise(r=>release=r);set(next);return true;}});const first=h.save(740);await Promise.resolve();await assert.rejects(h.save(850),/저장 중/);release();await first;assert.equal(h.value(),'740');assert.equal(h.writes.length,1);
  console.log('gui_availability_patch_runtime_test: PASS (success, invalid input, read failure, lost write, ambiguous write, rollback failure, blank restoration, concurrent save)');
})().catch(error=>{console.error(error);process.exitCode=1;});
