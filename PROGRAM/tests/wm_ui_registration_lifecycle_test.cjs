'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=process.env.WM_UI_REGISTRATION_SOURCE||path.resolve(__dirname,'../wm/src/parts/15e-gui-registration-iife-close.js');
console.log('WM_UI_REGISTRATION_SOURCE='+file);
const text=fs.readFileSync(file,'utf8'),code=text.slice(0,text.lastIndexOf('})();'));
async function run(kind){const registrations=new Map([['libra:unrelated',true]]),removed=[],unloads=[],calls=[];
 const host={registerSetting:async(name,callback,icon,type,id)=>{const actual='host:'+id;registrations.set(actual,callback);return kind==='disposer'?{remove:async()=>registrations.delete(actual)}:{id:actual}},registerButton:async(options,callback)=>{const actual='host:'+options.id;registrations.set(actual,callback);return kind==='disposer'?{dispose:async()=>registrations.delete(actual)}:{id:actual}},onUnload:async cb=>unloads.push(cb)};
 if(kind==='official')host.unregisterUIPart=async id=>{removed.push(id);registrations.delete(id)};
 const context=vm.createContext({RisuCompat:{host:()=>host,api:()=>host},LMAI_GUI:{show:async()=>calls.push('open')},LIBRA_LAUNCHER_BUTTON_ID:'lmai-button',unbindUiInteractionGuards(){},LibraToast:{cleanup:async()=>{}},recordRuntimeDebug(){}});
 vm.runInContext(code,context);for(let i=0;i<10&&!unloads.length;i++)await new Promise(r=>setImmediate(r));assert.equal(unloads.length,1);for(const cb of registrations.values())if(typeof cb==='function')await cb();for(const cb of unloads)await cb();return {registrations,removed,calls};}
test('wm_official_registration_cleanup_uses_returned_ids',async()=>{const r=await run('official');assert.deepEqual(r.removed,['host:lmai-settings','host:lmai-button']);assert.deepEqual([...r.registrations.keys()],['libra:unrelated']);assert.equal(r.calls.length,2)});
test('wm_returned_disposers_are_supported_without_legacy_fake_apis',async()=>{const r=await run('disposer');assert.deepEqual([...r.registrations.keys()],['libra:unrelated']);assert.deepEqual(r.removed,[])});
test('wm_host_without_removal_capability_is_explicitly_not_cleanup_qualified',async()=>{const r=await run('unsupported');assert.deepEqual(r.removed,[]);assert.equal(r.registrations.size,3,'legacy host limitation must remain visible, not a fake disposal claim')});
