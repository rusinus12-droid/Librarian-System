'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createMemorySuiteServer}=require('../server/server.cjs'),{createWmServerConnection}=require('../wm/src/wm-server-connection.source.js'),transport=require('./helpers/inprocess-review-transport.cjs');
test('WM manual connection accepts the genuine bootstrap and authenticated handler response envelope',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'wm-manual-handler-'));
 const app=createMemorySuiteServer({dataDir,token:'synthetic-offline-master-token-00000000000000000000',computeEnabled:false,autoBackup:false});
 const storage=new Map(),real=transport(app),responseShapes=[];
 const fetch=async(url,init)=>{const response=await real(url,init),raw=await response.text();responseShapes.push({path:new URL(url).pathname,status:response.status,keys:Object.keys(JSON.parse(raw)).sort()});return new Response(raw,{status:response.status,headers:response.headers});};
 const connection=createWmServerConnection({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);return true}},fetch});
 t.after(async()=>{connection.dispose();await app.close();app.server.emit('close');app.diagnosticJournal.close();fs.rmSync(dataDir,{recursive:true,force:true})});
 await connection.connectUsingBootstrap({baseUrl:'http://127.0.0.1:64521',confirmed:true});
 try{const status=await connection.requestManual('status');assert.equal(status.profile,'wm.manual-copy-switch.v1');assert.equal(status.allWritersFenced,false);assert.equal(status.nativeAtomic,false);assert.equal(app.server.listening,false);}catch(e){console.error(JSON.stringify({responseShapes}));throw e;}
});
test('WM bootstrap binding rejects substituted DATA before an owner request and requires explicit rebootstrap',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'wm-binding-handler-')),apps=[];
 const make=name=>{const app=createMemorySuiteServer({dataDir:path.join(root,name),token:'synthetic-shared-master-0000000000000000000000000',computeEnabled:false,autoBackup:false});apps.push(app);return app};
 let selected=make('one'),wire=transport(selected),requests=[],responseChange=null;
 const storage=new Map(),fetch=async(url,init)=>{requests.push({path:new URL(url).pathname,binding:init.headers['X-Memory-Suite-Data-Instance']||null});const response=await wire(url,init);let value=await response.json();if(responseChange&&new URL(url).pathname!=='/bootstrap')value=responseChange(value);return new Response(JSON.stringify(value),{status:response.status});};
 const connection=createWmServerConnection({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);return true}},fetch});
 t.after(async()=>{connection.dispose();for(const app of apps){await app.close();app.server.emit('close');app.diagnosticJournal.close()}fs.rmSync(root,{recursive:true,force:true})});
 const endpoint='http://127.0.0.1:64522';await connection.connectUsingBootstrap({baseUrl:endpoint,confirmed:true});
 const original=JSON.parse(storage.get('wm.server-connection.v1'));assert.match(original.dataInstanceId,/^[A-Za-z0-9_-]{32}$/);
 await connection.requestManual('status');assert.equal(requests.at(-1).binding,original.dataInstanceId,'bound header reaches the real handler');
 responseChange=value=>({...value,dataInstanceId:'A'.repeat(32)});await assert.rejects(connection.requestManual('status'),/connection_data_instance_changed/);
 responseChange=value=>{delete value.dataInstanceId;return value};await assert.rejects(connection.requestManual('status'),/connection_response_invalid/);
 responseChange=value=>({...value,extraUnknown:true});await assert.rejects(connection.requestManual('status'),/connection_response_invalid/);responseChange=null;
 await connection.saveConfiguration({baseUrl:endpoint,credential:''});assert.equal(JSON.parse(storage.get('wm.server-connection.v1')).dataInstanceId,original.dataInstanceId,'same-endpoint edit cannot silently erase physical binding');
 selected=make('replacement');wire=transport(selected);await assert.rejects(connection.requestManual('status'),/connection_data_instance_changed/);assert.equal(selected.wmService.status().initialized,false,'replaced DATA stays untouched before rebootstrap');
 const before=requests.length;await assert.rejects(connection.connectUsingBootstrap({baseUrl:endpoint,confirmed:false}),/confirmation/);assert.equal(requests.length,before);
 await connection.connectUsingBootstrap({baseUrl:endpoint,confirmed:true});const rebound=JSON.parse(storage.get('wm.server-connection.v1'));assert.notEqual(rebound.dataInstanceId,original.dataInstanceId);assert.equal((await connection.requestManual('status')).profile,'wm.manual-copy-switch.v1');
});
