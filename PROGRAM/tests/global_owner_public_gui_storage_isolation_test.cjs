'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {create}=require('./fixtures/libra_gui_memory_dom_host.cjs');
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'global-gui-storage-')),file=path.join(dir,'synthetic-owner.js');let f;try{
 fs.writeFileSync(file,'(async()=>{globalThis.__LIBRA__={openSettingsGui:async()=>{}};})();');
 f=await create('LIBRA','Full',{pluginPath:file,separateLocalStorage:true,initialValues:[['shared-key','PLUGIN']],initialDeviceValues:[['shared-key','DEVICE']]});
 const plugin=f.host.pluginStorage,device=await f.host.getLocalPluginStorage();
 assert.notEqual(plugin,device,'two storage spaces must not collapse to the same store');
 assert.equal(await plugin.getItem('shared-key'),'PLUGIN');assert.equal(await device.getItem('shared-key'),'DEVICE');
 await device.setItem('shared-key','DEVICE_NEW');assert.equal(await plugin.getItem('shared-key'),'PLUGIN','device update must not mutate plugin bytes');
 await plugin.setItem('shared-key','PLUGIN_NEW');assert.equal(await device.getItem('shared-key'),'DEVICE_NEW','plugin update must not mutate device bytes');
 assert.notEqual(f.values,f.deviceValues);assert.equal(f.deviceValues.get('shared-key'),'DEVICE_NEW');
 console.log('PASS independent physical plugin/device stores and restart seeds');
}finally{await f?.close();fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
