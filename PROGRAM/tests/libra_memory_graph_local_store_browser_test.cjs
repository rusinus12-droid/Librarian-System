'use strict';
// Native IndexedDB, two tabs and a Chromium process restart. No provider or host data.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process'),assert=require('node:assert/strict');
const {resolveChromeExecutable}=require('./fixtures/browser_resolver.cjs');
const createStore=require('../tools/libra_memory_graph_local_store.cjs');
const network=require('../tools/libra_memory_network.cjs'),{publish}=require('./fixtures/libra_local_store_fixture.cjs');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'libra-local-idb-'));fs.chmodSync(profile,0o700);
const server=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>LIBRA local index test</title>');});
let chrome,stderr='',sockets=[];
const stop=async()=>{for(const socket of sockets)socket.close();sockets=[];if(chrome&&chrome.exitCode===null){const exited=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill();await exited;}chrome=null;};
const launch=async()=>{
 fs.rmSync(path.join(profile,'DevToolsActivePort'),{force:true});stderr='';
 chrome=spawn(resolveChromeExecutable(),['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
 chrome.on('error',error=>{stderr=error.message;});
 for(let n=0;n<100;n++){try{return fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch(_){}if(chrome.exitCode!==null)throw new Error(stderr);await pause(50);}
 throw new Error('Chromium did not start: '+stderr);
};
async function connect(port,id=null){
 const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json(),target=targets.find(row=>id?row.id===id:row.type==='page');
 const ws=new WebSocket(target.webSocketDebuggerUrl);sockets.push(ws);
 await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
 let sequence=0;const pending=new Map();
 ws.addEventListener('message',event=>{const result=JSON.parse(event.data),entry=pending.get(result.id);if(!entry)return;pending.delete(result.id);clearTimeout(entry.timer);result.error?entry.reject(new Error(JSON.stringify(result.error))):entry.resolve(result.result);});
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},10000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const response=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(response.exceptionDetails)throw new Error(JSON.stringify(response.exceptionDetails));return response.result.value;};
 return{call,evaluate};
}
async function boot(tab,origin){
 await tab.call('Page.navigate',{url:origin});
 for(let n=0;n<100;n++){try{if(await tab.evaluate('location.origin === '+JSON.stringify(origin)+' && document.readyState === "complete"'))break;}catch(_){}await pause(20);}
 await tab.evaluate(`globalThis.hash=(${network.toString()})({hash:()=>''}).fingerprint;
 globalThis.prefix=scope=>'libra:v1:scope:'+scope+':memory-graph:v1:corpus:';
 globalThis.publish=(${publish.toString()});
 globalThis.localStore=(${createStore.toString()})({indexedDB,fingerprint:hash});localStore.ready().then(()=>true)`);
}
const watchdog=setTimeout(()=>{console.error('Native IndexedDB browser test timed out');chrome?.kill();process.exit(1);},60000);
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 let port=await launch(),a=await connect(port);await boot(a,origin);
 const id=(await a.call('Target.createTarget',{url:'about:blank'})).targetId,b=await connect(port,id);await boot(b,origin);
 await a.evaluate('globalThis.old=await publish(localStore,1);true');
 await b.evaluate('globalThis.reader=await localStore.acquire("test","read");await reader.read(prefix("test")+"root:r1");true');
 await a.evaluate('globalThis.current=await publish(localStore,2);true');
 const pinned=await a.evaluate('await localStore.collectGarbage("test")');assert.equal(pinned.status,'completed');assert.equal(pinned.protectedReaderCount,1);assert.equal(pinned.deletedKeys.length,0);
 assert.ok(await b.evaluate('await reader.read((await (async()=>{const root=JSON.parse(await reader.read(prefix("test")+"root:r1"));const manifest=JSON.parse(await reader.read(root.manifestKey));return manifest.refs[0].key;})()))'));
 await b.evaluate('await reader.release();true');
 const aborted=await a.evaluate(`globalThis.originalDelete=IDBObjectStore.prototype.delete;globalThis.deleteCalls=0;globalThis.abortResult=null;
 IDBObjectStore.prototype.delete=function(key){if(this.name==='records'&&++deleteCalls===2)throw new Error('injected_native_delete_failure');return originalDelete.call(this,key);};
 try{await localStore.collectGarbage('test');}catch(error){abortResult=error.message;}finally{IDBObjectStore.prototype.delete=originalDelete;}abortResult`);
 assert.equal(aborted,'injected_native_delete_failure');
 assert.ok(await a.evaluate(`globalThis.probe=await localStore.acquire('test','read');globalThis.probeRaw=await probe.read(old.page.key);await probe.release();probeRaw`),'native abort keeps the earlier scheduled deletion');
 const swept=await a.evaluate('await localStore.collectGarbage("test")');assert.ok(swept.deletedKeys.length>=10);
 const bounded=[];for(let n=3;n<9;n++)bounded.push(await a.evaluate(`await publish(localStore,${n});await localStore.collectGarbage('test')`));
 assert.ok(bounded.every(row=>row.status==='completed'&&row.inventoryRecords===bounded[0].inventoryRecords));
 await stop();port=await launch();a=await connect(port);await boot(a,origin);
 const restored=await a.evaluate('globalThis.reader=await localStore.acquire("test","read");JSON.parse(await reader.read(prefix("test")+"root:r8"))');assert.equal(restored.schema,'libra.graph_corpus.v1');
 await a.evaluate('await reader.release();true');
 console.log(JSON.stringify({test:'native_indexeddb_local_corpus',twoTabs:true,processRestart:true,atomicRollback:true,pinnedReaderPreserved:true,reclaimedAfterRelease:swept.deletedKeys.length,repeatBuildInventoryRecords:bounded.map(row=>row.inventoryRecords)}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);await stop();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});});
