'use strict';
const assert=require('node:assert/strict');
const KEY='LMAI_Config';
function decodePhysical(store){const root=JSON.parse(store.get(KEY));return root.__libraChunkedStorageV1?JSON.parse(root.chunks.map(key=>store.get(key)).join('')):root;}
async function importSettings(f,value){
 const envelope=f.w.LibraSettingsSchema.buildPublicExport({...decodePhysical(f.store),...value}),raw=JSON.stringify(envelope);
 assert(Buffer.byteLength(raw)<=262144,'portable file remains within the approved limit');
 const before=JSON.stringify([...f.store]),writes=f.calls.writes.length;
 const input=f.overlay.querySelector('#settings-file-input');assert.equal(typeof input.onchange,'function');
 await input.onchange({target:{files:[{name:'fixture-portable-settings.json',size:Buffer.byteLength(raw),text:async()=>raw}]}});
 assert.equal(JSON.stringify([...f.store]),before,'preview changes no physical data');assert.equal(f.calls.writes.length,writes,'preview invokes no writer');
 const apply=f.overlay.querySelector('#btn-apply-settings-import');assert.equal(apply.disabled,false,'actual portable preview is ready');
 return apply.onclick();
}
module.exports={decodePhysical,importSettings};
