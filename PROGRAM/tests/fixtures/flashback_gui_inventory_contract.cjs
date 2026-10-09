'use strict';
const assert=require('node:assert/strict');
const plain=x=>JSON.parse(JSON.stringify(x));
const sorted=xs=>plain(xs).sort();
const unique=(xs,label)=>assert.equal(new Set(xs).size,xs.length,label+' must be unique');
function check({api,html,source}){
 const t=api._test,fields=t.flashbackArgumentSettingFields,readOnly=t.flashbackReadOnlyArgumentSettings,special=t.flashbackSpecialArguments,rows=t.flashbackArgumentSettingRows();
 const declared=[...source.matchAll(/^\/\/@arg\s+(\S+)/gm)].map(m=>m[1]);
 const names=rows.map(r=>r.name),roNames=readOnly.map(r=>r.name);
 for(const [xs,label] of [[declared,'declared ARGs'],[names,'normal rows'],[roNames,'read-only policies'],[special.map(r=>r.name),'special policies'],[fields.map(r=>r.name),'editable fields']])unique(xs,label);
 assert.deepEqual(sorted([...names,...special.map(r=>r.name)]),sorted(declared),'every declared ARG has exactly one audit policy');
 assert.ok(readOnly.every(p=>names.includes(p.name)),'read-only policies reference normal settings');
 assert.ok(fields.every(f=>names.includes(f.name)&&!roNames.includes(f.name)),'editable fields reference non-read-only settings');
 const tags=[...html.matchAll(/<[^>]+>/g)].map(m=>m[0]);
 const attr=(tag,name)=>tag.match(new RegExp('(?:\\s|^)'+name+'="([^"]*)"'))?.[1];
 const ids=tags.map(tag=>attr(tag,'id')).filter(Boolean);unique(ids,'rendered IDs');
 for(const row of rows){
  assert.equal(row.editable,!roNames.includes(row.name),'normal setting has an editable control or explicit read-only policy: '+row.name);
  if(row.editable)assert(ids.includes(row.controlId),'rendered control missing: '+row.name);
 }
 const audit=tags.map(tag=>attr(tag,'data-argument-row')).filter(Boolean);
 assert.deepEqual(sorted(audit),sorted(declared),'rendered audit covers every declared ARG once');
 const fieldIds=fields.map(f=>t.argumentSettingControlForKey(f.key));
 assert.deepEqual(sorted(ids.filter(id=>id.startsWith('argSetting_'))),sorted(fieldIds),'rendered expert fields match current editable settings');
 const tabs=tags.filter(tag=>attr(tag,'role')==='tab'),panels=tags.filter(tag=>attr(tag,'role')==='tabpanel');
 for(const id of ['tab-overview','tab-worldline','tab-source-edits','tab-restore'])assert(ids.includes(id),'required navigation missing: '+id);
 const targets=tabs.map(tag=>attr(tag,'aria-controls'));unique(targets,'tab targets');
 assert.deepEqual(sorted(targets),sorted(panels.map(tag=>attr(tag,'id'))),'each current tab has one matching panel including storage subpanels');
 const toggles=tags.filter(tag=>attr(tag,'data-toggle-arg-setting-group'));
 const groupTargets=toggles.map(tag=>attr(tag,'aria-controls'));
 unique(groupTargets,'ARG group targets');
 const groupPanels=tags.filter(tag=>(attr(tag,'class')||'').split(/\s+/).includes('arg-setting-panel'));
 assert.deepEqual(sorted(groupTargets),sorted(groupPanels.map(tag=>attr(tag,'id'))),'ARG group toggles match controlled panels');
 assert.equal(toggles.filter(tag=>attr(tag,'aria-expanded')==='true').length,1,'only first ARG group opens initially');
 for(const toggle of toggles){const panel=groupPanels.find(tag=>attr(tag,'id')===attr(toggle,'aria-controls'));assert.equal(/\shidden(?:\s|>)/.test(panel),attr(toggle,'aria-expanded')!=='true','group visibility matches expanded state');}
 assert.ok(fields.every(f=>toggles.some(tag=>attr(tag,'data-toggle-arg-setting-group')===f.group)),'each field has a rendered group');
}
module.exports={check};
