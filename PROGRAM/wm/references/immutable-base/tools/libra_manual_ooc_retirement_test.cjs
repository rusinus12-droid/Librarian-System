'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const base=path.join(__dirname,'../src/parts');const read=n=>fs.readFileSync(path.join(base,n),'utf8');
const checks=[];async function test(name,fn){try{await fn();checks.push({name,ok:true})}catch(e){checks.push({name,ok:false,error:e.message})}}
(async()=>{
const schema=read('01d-debug-export-runtime-trace.js');
const body=schema.slice(schema.indexOf('    const normalizeSettingsAliases ='),schema.indexOf('    const SETTINGS_SECRET_KEY_RE'));
const ctx=vm.createContext({SETTINGS_KEY_ALIASES:{},hasNestedSettingValue:()=>false,setNestedSettingValue:()=>{}});vm.runInContext(body+'\nglobalThis.normalize=normalizeSettingsAliases;',ctx);
for(const v of [true,'true',false])await test('legacy OOC keys removed without mutating input: '+v,()=>{const c={manualOocPause:v,manual_ooc_pause:v,debug:false,storyAuthorEnabled:true};const n=ctx.normalize(c);assert(!Object.hasOwn(n,'manualOocPause'));assert(!Object.hasOwn(n,'manual_ooc_pause'));assert.equal(n.debug,false);assert.equal(n.storyAuthorEnabled,true);assert.equal(c.manualOocPause,v)});
for(const phase of ['before','after'])await test(phase+' request continues with legacy pause=true',async()=>{
const source=read(phase==='before'?'13c-before-request-injection.js':'13d-after-request-worker-unload.js');
const start=source.indexOf(phase==='before'?'    const libraBeforeRequestReplacer =':'    const runLibraAfterRequestWorker =');
const end=source.indexOf(phase==='before'?'        const requestContainer =':'        if (!Utils.isModelRequestType(type))',start);
assert(start>=0&&end>start);
let cleared=0;const c=vm.createContext({MemoryEngine:{CONFIG:{manualOocPause:true}},isLibraManualOocPauseEnabled:()=>true,DebugExportManager:{startRequest:()=>'',finishRequest:()=>{},textDigest:x=>x},extractResponseTextValue:x=>x,detectMainResponseLanguageTarget:()=>'',clearLibraTransientRuntimeState:()=>{cleared++}});
vm.runInContext(source.slice(start,end)+`\nreturn 'continued';};globalThis.run=${phase==='before'?'libraBeforeRequestReplacer':'runLibraAfterRequestWorker'};`,c);
assert.equal(await c.run(phase==='before'?[]:'answer','model'),'continued');assert.equal(cleared,0);
});
await test('no pause control or host argument remains',()=>{assert(!read('15-gui-and-exports.js').includes('id="soocpause"'));assert(!read('00-plugin-shell-and-args.js').includes('//@arg manual_ooc_pause'))});
for(const f of ['05h-turn-maintenance-worker.js','05i-turn-maintenance-scheduler-analysis.js','13a-response-transport-recovery.js','05j-pending-turn-manager.js','13-risu-triggers-streaming.js','14-main-initialization.js','15d-gui-events-finalize.js'])await test('no retired runtime gating in '+f,()=>assert(!/isLibraManualOocPauseEnabled|syncManualOocPauseConfig|applyManualOocPauseRuntimeState/.test(read(f))));
console.log(JSON.stringify({passed:checks.filter(x=>x.ok).length,failed:checks.filter(x=>!x.ok).length,checks},null,2));if(checks.some(x=>!x.ok))process.exitCode=1;
})();
