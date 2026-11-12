'use strict';
// Two access modes. Local (default): loopback only, no key. Remote: still loopback only, and every
// /bootstrap needs the access key, this PC included, because other devices arrive through a tunnel
// (tailscale serve, Cloudflare Tunnel) from loopback as well. Remote tokens die with the server start.
// A container is a separate device: remote mode is fixed and it listens on its own interface.
// Plugins accept http:// only for loopback addresses and https:// for anything else.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer}=require('../server/server.cjs');
const launcher=require('../tools/platform_launcher.cjs');
const {copyIdentityAndEndpoint}=require('../../UPDATER/core/migration-required.cjs');
const identity=require('../../UPDATER/core/data-identity.cjs');
const lan=Object.values(os.networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&!a.internal)?.address||'';
const noLan={skip:lan?false:'no non-loopback IPv4 interface on this machine'};

function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'suite-remote-access-'));return {root,data:path.join(root,'DATA'),close(){fs.rmSync(root,{recursive:true,force:true});}};}
async function enable(data){const out=[];await launcher.setRemoteAccess(data,'remote',{write:t=>out.push(t)});return {key:fs.readFileSync(path.join(data,'config','remote-access-key.txt'),'utf8').trim(),out:out.join('')};}
async function start(data,options={}){const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:data,autoBackup:false,computeEnabled:false,...options});const a=await app.listen();return {app,port:a.port,address:a.address};}
const get=async(url,headers={})=>{const res=await fetch(url,{headers:{...headers,Connection:'close'}});return {status:res.status,body:await res.json().catch(()=>null)};};
const H={'X-Memory-Suite-Plugin':'libra'};
const plain=v=>JSON.parse(JSON.stringify(v));

const auth=payload=>({...H,Authorization:'Bearer '+payload.token,'X-Memory-Suite-Reset-Epochs':JSON.stringify(payload.resetEpochs||{})});

test('launcher: remote/local/rotate/show keep the key and say a restart applies the change',async()=>{
  const t=temp();try{
    const first=await enable(t.data);
    assert.match(first.key,/^[A-Za-z0-9_-]{43}$/);
    assert.match(first.out,new RegExp('접근 키: '+first.key));
    assert.match(first.out,/다시 실행해야 반영/,'the tool says the change applies after a restart');
    assert.equal(launcher.readConfig(t.data).remoteAccess,true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.data,'config','server-config.json'),'utf8')).host,'127.0.0.1','the configured host stays loopback');
    if(process.platform!=='win32')assert.equal(fs.statSync(path.join(t.data,'config','remote-access-key.txt')).mode&0o077,0,'the key file is private');
    const again=await enable(t.data);
    assert.equal(again.key,first.key,'remote again keeps the key');
    assert.match(again.out,/이미 원격 접속 모드/);
    const shown=[];assert.deepEqual(await launcher.setRemoteAccess(t.data,'show',{write:x=>shown.push(x)}),{enabled:true,keyPresent:true});
    assert.match(shown.join(''),/원격 접속 모드/);
    const rotatedOut=[];await launcher.setRemoteAccess(t.data,'rotate',{write:x=>rotatedOut.push(x)});
    assert.match(rotatedOut.join(''),/다시 실행해야 반영/);
    const rotated=fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim();
    assert.notEqual(rotated,first.key);
    const localOut=[];await launcher.setRemoteAccess(t.data,'local',{write:x=>localOut.push(x)});
    assert.match(localOut.join(''),/다시 실행해야 반영/);
    assert.match(localOut.join(''),/보존/);
    assert.equal(launcher.readConfig(t.data).remoteAccess,false);
    assert.equal(fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim(),rotated,'local keeps the key file');
    assert.equal((await enable(t.data)).key,rotated,'back to remote mode with the same key');
    await assert.rejects(()=>launcher.setRemoteAccess(t.data,'enable',{write:()=>{}}),/알 수 없는 동작/);
    assert.throws(()=>launcher.parseArgs(['set-remote-access','--remote','--local']),/launcher_remote_action_conflict/);
    assert.throws(()=>launcher.parseArgs(['set-remote-access','--enable']),/unknown_launcher_argument/);
  }finally{t.close();}
});

test('launcher: a container cannot leave remote mode, and a fresh heartbeat counts as a running server',async()=>{
  const t=temp();try{
    await enable(t.data);
    await assert.rejects(()=>launcher.setRemoteAccess(t.data,'local',{write:()=>{},container:true}),e=>e.code==='SERVER_REMOTE_CONTAINER_FIXED');
    const previous=process.env.LIBRARIAN_CONTAINER;process.env.LIBRARIAN_CONTAINER='1';
    const beat=path.join(t.data,'config','server-heartbeat.json');
    try{
      fs.writeFileSync(beat,JSON.stringify({at:Date.now()}));
      await assert.rejects(()=>launcher.setRemoteAccess(t.data,'rotate',{write:()=>{}}),e=>e.code==='SERVER_REMOTE_SERVER_RUNNING','another container is running the server');
      await assert.rejects(()=>launcher.setServerPort(t.data,'48123',{write:()=>{}}),e=>e.code==='SERVER_PORT_SERVER_RUNNING');
      fs.writeFileSync(beat,JSON.stringify({at:Date.now()-120000}));
      await launcher.setRemoteAccess(t.data,'rotate',{write:()=>{}});
      assert.ok((await enable(t.data)).key,'remote while already remote needs no stopped server (entrypoint after a crash)');
    }finally{if(previous===undefined)delete process.env.LIBRARIAN_CONTAINER;else process.env.LIBRARIAN_CONTAINER=previous;}
  }finally{t.close();}
});

test('server: remote mode needs a valid key file; local mode needs no key and listens on loopback only',async()=>{
  const t=temp();try{
    fs.mkdirSync(path.join(t.data,'config'),{recursive:true});
    assert.throws(()=>createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:t.data,autoBackup:false,computeEnabled:false,remoteAccess:true}),/remote_access_key_missing_or_invalid/);
    const s=await start(t.data);
    try{
      const health=await get(`http://127.0.0.1:${s.port}/health`);
      assert.equal(health.status,200);assert.deepEqual(health.body.remoteAccess,{enabled:false,container:false});
      const boot=await get(`http://127.0.0.1:${s.port}/bootstrap`,H);
      assert.equal(boot.status,200,'local mode: the same PC connects without a key');
      if(lan)await assert.rejects(()=>fetch(`http://${lan}:${s.port}/health`),'a local-mode server is not reachable from another address');
    }finally{await s.app.close();}
  }finally{t.close();}
});

test('server: remote mode stays on loopback and keys every /bootstrap, loopback included',async()=>{
  const t=temp();try{
    const {key}=await enable(t.data);
    const s=await start(t.data,{portableSettingsFromData:true});
    try{
      assert.equal(s.address,'127.0.0.1','remote mode does not widen where the server listens');
      if(lan)await assert.rejects(()=>fetch(`http://${lan}:${s.port}/health`),'not reachable from another address');
      const base=`http://127.0.0.1:${s.port}`;
      assert.deepEqual((await get(base+'/health')).body.remoteAccess,{enabled:true,container:false});
      const missing=await get(base+'/bootstrap',H);
      assert.deepEqual([missing.status,missing.body.error],[403,'remote_access_key_required'],'a loopback /bootstrap without the key is refused');
      assert.equal((await get(base+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':'x'.repeat(43)})).status,403,'a wrong key is refused');
      const boot=await get(base+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':key});
      assert.equal(boot.status,200);assert.ok(boot.body.token);
      const kv=`${base}/v1/kv/get?namespace=libra&space=plugin&key=x`;
      assert.equal((await get(kv,auth(boot.body))).status,200,'the issued token works');
      assert.equal((await get(kv,H)).status,403,'other routes still require the token');
    }finally{await s.app.close();}
  }finally{t.close();}
});

test('server: a restart, a rotation or a mode change revokes remote tokens',async()=>{
  const t=temp();try{
    const {key}=await enable(t.data);
    let s=await start(t.data,{portableSettingsFromData:true});
    const route='/v1/kv/get?namespace=libra&space=plugin&key=x';
    try{
      const boot=await get(`http://127.0.0.1:${s.port}/bootstrap`,{...H,'X-Memory-Suite-Access-Key':key});
      assert.equal(boot.status,200);
      await s.app.close();s=null;
      s=await start(t.data,{portableSettingsFromData:true});
      const stale=await get(`http://127.0.0.1:${s.port}${route}`,auth(boot.body));
      assert.deepEqual([stale.status,stale.body.reason],[403,'capability_token_invalid'],'a token from the previous start is refused and marked for a re-bootstrap');
      const fresh=await get(`http://127.0.0.1:${s.port}/bootstrap`,{...H,'X-Memory-Suite-Access-Key':key});
      assert.equal((await get(`http://127.0.0.1:${s.port}${route}`,auth(fresh.body))).status,200);
      await s.app.close();s=null;
      await launcher.setRemoteAccess(t.data,'rotate',{write:()=>{}});
      const newKey=fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim();
      s=await start(t.data,{portableSettingsFromData:true});
      assert.equal((await get(`http://127.0.0.1:${s.port}/bootstrap`,{...H,'X-Memory-Suite-Access-Key':key})).status,403,'the old key no longer connects');
      assert.equal((await get(`http://127.0.0.1:${s.port}/bootstrap`,{...H,'X-Memory-Suite-Access-Key':newKey})).status,200);
      await s.app.close();s=null;
      await launcher.setRemoteAccess(t.data,'local',{write:()=>{}});
      s=await start(t.data,{portableSettingsFromData:true});
      const local=await get(`http://127.0.0.1:${s.port}/bootstrap`,H);
      assert.equal(local.status,200,'local mode again: no key');
      assert.equal((await get(`http://127.0.0.1:${s.port}${route}`,auth(fresh.body))).body.reason,'capability_token_invalid','remote tokens do not survive the mode change');
    }finally{if(s)await s.app.close();}
  }finally{t.close();}
});

test('server: a container is remote mode on its own interface and keeps a heartbeat',noLan,async()=>{
  const t=temp();try{
    const {key}=await enable(t.data);
    // The config says local mode; the container must ignore that.
    fs.writeFileSync(path.join(t.data,'config','server-config.json'),JSON.stringify({...JSON.parse(fs.readFileSync(path.join(t.data,'config','server-config.json'),'utf8')),remoteAccess:{enabled:false}}));
    const s=await start(t.data,{portableSettingsFromData:true,container:true});
    const beat=path.join(t.data,'config','server-heartbeat.json');
    try{
      assert.equal(s.address,'0.0.0.0');
      const remote=`http://${lan}:${s.port}`;
      assert.deepEqual((await get(remote+'/health')).body.remoteAccess,{enabled:true,container:true},'remote mode is forced even when the config says local');
      assert.equal((await get(remote+'/bootstrap',H)).status,403,'a container treats every connection as another device');
      assert.equal((await get(`http://127.0.0.1:${s.port}/bootstrap`,H)).status,403);
      assert.equal((await get(remote+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':key})).status,200);
      assert.ok(fs.existsSync(beat),'the container writes a heartbeat into DATA');
    }finally{await s.app.close();}
    assert.equal(fs.existsSync(beat),false,'a graceful stop removes the heartbeat');
  }finally{t.close();}
});

for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.flashback.source.js','MemorySuiteStorageClient.libra.source.js']){
  const makeBridge=(args,pluginStorage,nativeFetch,bridges)=>{
    const context={risuai:{getArgument:async k=>args.get(k)||'',setArgument:async(k,v)=>{args.set(k,v);return true;},nativeFetch,pluginStorage},console:{warn(){},log(){}},URL,AbortController,TextEncoder,setTimeout,clearTimeout,crypto:crypto.webcrypto};
    vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')+'\nthis.factory=createMemorySuiteStorageBridge;',context);
    const ns=file.includes('flashback')?'flashback':file.includes('libra')?'libra':'hayaku';
    const bridge=context.factory({namespace:ns,pluginId:ns,pluginPrefixes:[ns+':'],scopeRouting:false,autoMigratePlugin:false,autoMigrateLocal:false,managementButton:false,startupDiagnostics:false,requestTimeoutMs:8000,bootstrapRequestTimeoutMs:8000});
    bridges.push(bridge);return {bridge,ns};
  };
  const storageFor=()=>{const stored=new Map();return {getItem:async k=>stored.has(k)?stored.get(k):null,setItem:async(k,v)=>{stored.set(k,String(v));},removeItem:async k=>{stored.delete(k);}};};

  test(file+': a remote-mode server on this PC needs the saved key, and a restart re-bootstraps once',async()=>{
    const t=temp();const bridges=[];try{
      const {key}=await enable(t.data);
      let s=await start(t.data,{portableSettingsFromData:true});
      try{
        const args=new Map([['memory_suite_server_mode','server_only'],['memory_suite_server_url',`http://127.0.0.1:${s.port}`]]),sent=[];
        const pluginStorage=storageFor();
        const nativeFetch=async(url,init)=>{const row={url,key:init.headers?.['X-Memory-Suite-Access-Key']||'',status:0};sent.push(row);const res=await fetch(url,{...init,headers:{...init.headers,Connection:'close'}});row.status=res.status;return res;};
        const {bridge:b,ns}=makeBridge(args,pluginStorage,nativeFetch,bridges);
        await assert.rejects(()=>b.bootstrap(true),/remote_access_key_required|403/,'without a key even this PC is refused');
        assert.deepEqual(plain(await b.getServerAccessKeyStatus()),{configured:false});
        await assert.rejects(()=>b.setServerAccessKey('short'),/MEMORY_SUITE_ACCESS_KEY_INVALID|memory_suite_access_key_invalid/);
        assert.deepEqual(plain(await b.setServerAccessKey(key)),{configured:true});
        assert.ok((await b.bootstrap(true)).token);
        const probe=await b.testConnection(`http://127.0.0.1:${s.port}`);assert.equal(probe.ok,true,probe.error);
        const keyed=sent.filter(x=>x.key);
        assert.ok(keyed.length>=2&&keyed.every(x=>x.key===key&&/\/bootstrap$/.test(x.url)),'the key travels on /bootstrap only');
        assert.ok(!Object.values(b).some(v=>v===key),'the bridge never exposes the key');
        // Restart on the same port: the cached token is now invalid; the next request bootstraps again by itself.
        const port=s.port;await s.app.close();s=null;
        s=await start(t.data,{portableSettingsFromData:true,port});
        const before=sent.filter(x=>/\/bootstrap$/.test(x.url)).length;
        const routedBefore=sent.length;
        assert.ok(await b.serverIntegrity(),'a token-authorized request succeeds after one re-bootstrap');
        const after=sent.slice(routedBefore);
        assert.ok(after.some(x=>!/\/bootstrap$/.test(x.url)&&x.status===403),'the cached token was refused first');
        assert.ok(after.some(x=>!/\/bootstrap$/.test(x.url)&&x.status===200),'then the same request went through');
        assert.equal(sent.filter(x=>/\/bootstrap$/.test(x.url)).length,before+1,'exactly one re-bootstrap');
        await b.setServerAccessKey('');
        assert.deepEqual(plain(await b.getServerAccessKeyStatus()),{configured:false});
        await assert.rejects(()=>b.bootstrap(true),/remote_access_key_required|403/,'a cleared key no longer connects');
      }finally{for(const bridge of bridges)await bridge.dispose().catch(()=>{});if(s)await s.app.close();}
    }finally{t.close();}
  });

  test(file+': only loopback addresses may use http://; other devices need https://',async()=>{
    const bridges=[];try{
      const {bridge:b}=makeBridge(new Map(),storageFor(),async()=>{throw new Error('no network in this test');},bridges);
      for(const url of ['http://192.168.0.10:47630','http://my-pc.tailnet.ts.net','http://example.com:47630','http://100.64.0.5:47630']){
        const result=await b.testConnection(url).catch(error=>({ok:false,error:String(error?.code||'')+' '+String(error?.message||error)}));
        assert.equal(result.ok,false,url);
        assert.match(String(result.error),/server_url_remote_requires_https|INVALID_SERVER_URL/,url+' is refused as an address, not as a network failure');
      }
      for(const url of ['http://127.0.0.1:47630','http://localhost:47630','http://[::1]:47630','http://host.docker.internal:47630','https://my-pc.tailnet.ts.net','https://librarian.example.com']){
        const result=await b.testConnection(url).catch(error=>({ok:false,error:String(error?.code||'')+' '+String(error?.message||error)}));
        assert.doesNotMatch(String(result.error||''),/INVALID_SERVER_URL|server_url_/,url+' is an accepted address');
      }
      const rejected=await b.testConnection('https://user:pw@my-pc.tailnet.ts.net').catch(error=>({ok:false,error:String(error?.message||error)}));
      assert.match(String(rejected.error),/server_url_must_be_loopback_http_or_https|INVALID_SERVER_URL/,'credentials in the address are refused');
    }finally{for(const bridge of bridges)await bridge.dispose().catch(()=>{});}
  });
}

test('updater migration carries the access key and the remote access switch',async()=>{
  const t=temp();try{
    const {key}=await enable(t.data);
    fs.writeFileSync(path.join(t.data,'runtime-token.txt'),crypto.randomBytes(36).toString('base64url')+'\n');
    if(!fs.existsSync(identity.identityPath(t.data)))identity.ensureDataInstanceIdentity?.(t.data);
    const next=path.join(t.root,'DATA.next');fs.mkdirSync(path.join(next,'config'),{recursive:true});
    fs.writeFileSync(path.join(next,'config','server-config.json'),JSON.stringify({schema:'memory-suite.server-config.v1',host:'127.0.0.1',port:47630}));
    await copyIdentityAndEndpoint(t.data,next);
    assert.equal(fs.readFileSync(path.join(next,'config','remote-access-key.txt'),'utf8').trim(),key);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(next,'config','server-config.json'),'utf8')).remoteAccess,{enabled:true});
  }finally{t.close();}
});
