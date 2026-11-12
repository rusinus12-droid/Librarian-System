'use strict';
// Remote access (Docker): off by default the server is loopback-only. Turned on, it listens on every
// address. The same PC and the local network (private addresses; a Docker bridge gateway is one) connect
// without a key exactly as before; only a client outside it (internet, VPN/CGNAT) needs the access key
// from DATA/config to get a capability token. The embedded SDK sends the key it saved per namespace on
// /bootstrap only and never hands it back.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const {createMemorySuiteServer,isLocalNetworkAddress}=require('../server/server.cjs');
const launcher=require('../tools/platform_launcher.cjs');
const {copyIdentityAndEndpoint}=require('../../UPDATER/core/migration-required.cjs');
const identity=require('../../UPDATER/core/data-identity.cjs');
// This machine's non-loopback addresses: a private one stands in for the local network (a Docker
// bridge gateway is one), any other for a client outside it. Each socket test runs when such an address exists.
const addresses=Object.values(os.networkInterfaces()).flat().filter(a=>a&&a.family==='IPv4'&&!a.internal).map(a=>a.address);
const localLan=addresses.find(a=>isLocalNetworkAddress(a))||'',outsideLan=addresses.find(a=>!isLocalNetworkAddress(a))||'';
const lan=outsideLan||addresses[0]||'';
const noLan={skip:lan?false:'no non-loopback IPv4 interface on this machine'};
const outside={skip:outsideLan?false:'no address outside the local network on this machine'};
const inside={skip:localLan?false:'no private network address on this machine'};

test('address rule: same PC and local network need no key, everything else does',()=>{
  for(const a of ['127.0.0.1','127.9.9.9','::1','::ffff:127.0.0.1','10.0.0.5','172.16.0.1','172.17.0.1','172.31.255.1','192.168.0.10','::ffff:192.168.1.2','169.254.10.1','fd00::1','fc12:3456::1','fe80::1','fe80::1%eth0'])
    assert.equal(isLocalNetworkAddress(a),true,a);
  for(const a of ['100.64.0.1','100.68.49.86','172.15.0.1','172.32.0.1','8.8.8.8','11.0.0.1','192.169.0.1','2001:db8::1','2606:4700::1','',undefined])
    assert.equal(isLocalNetworkAddress(a),false,String(a));
});

function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'suite-remote-access-'));return {root,data:path.join(root,'DATA'),close(){fs.rmSync(root,{recursive:true,force:true});}};}
async function enable(data){const out=[];await launcher.setRemoteAccess(data,'enable',{write:t=>out.push(t)});return {key:fs.readFileSync(path.join(data,'config','remote-access-key.txt'),'utf8').trim(),out:out.join('')};}
async function start(data,options={}){const app=createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:data,autoBackup:false,computeEnabled:false,...options});const a=await app.listen();return {app,port:a.port};}
const get=async(url,headers={})=>{const res=await fetch(url,{headers:{...headers,Connection:'close'}});return {status:res.status,body:await res.json().catch(()=>null)};};
const H={'X-Memory-Suite-Plugin':'libra'};
const plain=v=>JSON.parse(JSON.stringify(v));

test('launcher: enable writes a key and config, show/rotate/disable keep their meaning',async()=>{
  const t=temp();try{
    const first=await enable(t.data);
    assert.match(first.key,/^[A-Za-z0-9_-]{43}$/);
    assert.match(first.out,new RegExp('접근 키: '+first.key));
    assert.equal(launcher.readConfig(t.data).remoteAccess,true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.data,'config','server-config.json'),'utf8')).host,'127.0.0.1','the configured host stays loopback');
    if(process.platform!=='win32')assert.equal(fs.statSync(path.join(t.data,'config','remote-access-key.txt')).mode&0o077,0,'the key file is private');
    assert.equal((await enable(t.data)).key,first.key,'enabling again keeps the key');
    const shown=[];assert.deepEqual(await launcher.setRemoteAccess(t.data,'show',{write:x=>shown.push(x)}),{enabled:true,keyPresent:true});
    await launcher.setRemoteAccess(t.data,'rotate',{write:()=>{}});
    const rotated=fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim();
    assert.notEqual(rotated,first.key);
    await launcher.setRemoteAccess(t.data,'disable',{write:()=>{}});
    assert.equal(launcher.readConfig(t.data).remoteAccess,false);
    assert.equal(fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim(),rotated,'disabling keeps the key for later');
    await assert.rejects(()=>launcher.setRemoteAccess(t.data,'open',{write:()=>{}}),/알 수 없는 동작/);
    assert.throws(()=>launcher.parseArgs(['set-remote-access','--enable','--disable']),/launcher_remote_action_conflict/);
  }finally{t.close();}
});

test('server: remote access needs a valid key file and is off unless asked for',async()=>{
  const t=temp();try{
    fs.mkdirSync(path.join(t.data,'config'),{recursive:true});
    assert.throws(()=>createMemorySuiteServer({host:'127.0.0.1',port:0,dataDir:t.data,autoBackup:false,computeEnabled:false,remoteAccess:true}),/remote_access_key_missing_or_invalid/);
    const s=await start(t.data);
    try{
      const health=await get(`http://127.0.0.1:${s.port}/health`);
      assert.equal(health.status,200);assert.deepEqual(health.body.remoteAccess,{enabled:false});
      if(lan)await assert.rejects(()=>fetch(`http://${lan}:${s.port}/health`),'a loopback-only server is not reachable from another address');
    }finally{await s.app.close();}
  }finally{t.close();}
});

test('server: a local-network /bootstrap needs no key even with a key set',inside,async()=>{
  const t=temp();try{
    await enable(t.data);
    const s=await start(t.data,{portableSettingsFromData:true});
    try{
      const boot=await get(`http://${localLan}:${s.port}/bootstrap`,H);
      assert.equal(boot.status,200,'a private address connects without the key');assert.ok(boot.body.token);
      assert.equal((await get(`http://127.0.0.1:${s.port}/bootstrap`,H)).status,200);
    }finally{await s.app.close();}
  }finally{t.close();}
});

test('server: an outside /bootstrap needs the key; same-host requests do not',outside,async()=>{
  const t=temp();try{
    const {key}=await enable(t.data);
    let s=await start(t.data,{portableSettingsFromData:true});
    try{
      const local=`http://127.0.0.1:${s.port}`,remote=`http://${outsideLan}:${s.port}`;
      const localBoot=await get(local+'/bootstrap',H);
      assert.equal(localBoot.status,200,'same host needs no key');
      assert.deepEqual((await get(remote+'/health')).body.remoteAccess,{enabled:true});
      assert.deepEqual([(await get(remote+'/bootstrap',H)).status,(await get(remote+'/bootstrap',H)).body.error],[403,'remote_access_key_required']);
      assert.equal((await get(remote+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':'x'.repeat(43)})).status,403,'a wrong key is refused');
      const boot=await get(remote+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':key});
      assert.equal(boot.status,200);assert.ok(boot.body.token);
      const kv=`${remote}/v1/kv/get?namespace=libra&space=plugin&key=x`;
      const auth=payload=>({...H,Authorization:'Bearer '+payload.token,'X-Memory-Suite-Reset-Epochs':JSON.stringify(payload.resetEpochs||{})});
      assert.equal((await get(kv,auth(boot.body))).status,200,'the issued token works remotely');
      assert.equal((await get(kv,auth(localBoot.body))).status,403,'a local token cannot authorize an external request');
      assert.equal((await get(kv,H)).status,403,'other routes still require the token');
      await s.app.close();s=null;
      await launcher.setRemoteAccess(t.data,'rotate',{write:()=>{}});
      const newKey=fs.readFileSync(path.join(t.data,'config','remote-access-key.txt'),'utf8').trim();
      s=await start(t.data,{portableSettingsFromData:true});
      const rotated=`http://${outsideLan}:${s.port}`;
      const route='/v1/kv/get?namespace=libra&space=plugin&key=x';
      assert.equal((await get(rotated+route,auth(boot.body))).status,403,'rotation revokes already issued external tokens');
      assert.equal((await get(rotated+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':key})).status,403);
      const current=await get(rotated+'/bootstrap',{...H,'X-Memory-Suite-Access-Key':newKey});
      assert.equal(current.status,200);
      assert.equal((await get(rotated+route,auth(current.body))).status,200);
      assert.equal((await get(`http://127.0.0.1:${s.port}`+route,auth(localBoot.body))).status,200,'local tokens survive key rotation');
    }finally{if(s)await s.app.close();}
  }finally{t.close();}
});

const hasIPv6Loopback=Object.values(os.networkInterfaces()).flat().some(address=>address?.internal&&address.address==='::1');
test('server: a configured IPv6 loopback keeps serving after external access is enabled',{skip:!hasIPv6Loopback},async()=>{
  const t=temp();try{
    await enable(t.data);
    const configFile=path.join(t.data,'config','server-config.json');
    const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
    fs.writeFileSync(configFile,JSON.stringify({...config,host:'::1'}));
    const {app,port}=await start(t.data,{host:'::1',portableSettingsFromData:true});
    try{
      assert.equal((await get(`http://[::1]:${port}/health`)).status,200);
      assert.equal((await get(`http://127.0.0.1:${port}/bootstrap`,H)).status,200);
    }finally{await app.close();}
  }finally{t.close();}
});

for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.flashback.source.js','MemorySuiteStorageClient.libra.source.js']){
  test(file+': the saved access key reaches a remote-access server from outside the local network',outside,async()=>{
    const t=temp();const bridges=[];try{
      const {key}=await enable(t.data);
      const s=await start(t.data,{portableSettingsFromData:true});
      try{
        const args=new Map([['memory_suite_server_mode','server_only'],['memory_suite_server_url',`http://127.0.0.1:${s.port}`]]),stored=new Map(),sent=[];
        const pluginStorage={getItem:async k=>stored.has(k)?stored.get(k):null,setItem:async(k,v)=>{stored.set(k,String(v));},removeItem:async k=>{stored.delete(k);}};
        // The plugin talks to 127.0.0.1; the request is sent to this machine's outside address instead.
        const nativeFetch=async(url,init)=>{sent.push({url,key:init.headers?.['X-Memory-Suite-Access-Key']||''});return fetch(url.replace('//127.0.0.1:',`//${outsideLan}:`),{...init,headers:{...init.headers,Connection:'close'}});};
        const make=()=>{const context={risuai:{getArgument:async k=>args.get(k)||'',setArgument:async(k,v)=>{args.set(k,v);return true;},nativeFetch,pluginStorage},console:{warn(){},log(){}},URL,AbortController,TextEncoder,setTimeout,clearTimeout,crypto:crypto.webcrypto};
          vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../sdk',file),'utf8')+'\nthis.factory=createMemorySuiteStorageBridge;',context);
          const ns=file.includes('flashback')?'flashback':file.includes('libra')?'libra':'hayaku';
          const bridge=context.factory({namespace:ns,pluginId:ns,pluginPrefixes:[ns+':'],scopeRouting:false,autoMigratePlugin:false,autoMigrateLocal:false,managementButton:false,startupDiagnostics:false,requestTimeoutMs:8000,bootstrapRequestTimeoutMs:8000});bridges.push(bridge);return bridge;};
        const b=make();
        await assert.rejects(()=>b.bootstrap(true),/remote_access_key_required|403/,'without a key the remote server refuses');
        assert.deepEqual(plain(await b.getServerAccessKeyStatus()),{configured:false});
        await assert.rejects(()=>b.setServerAccessKey('short'),/MEMORY_SUITE_ACCESS_KEY_INVALID|memory_suite_access_key_invalid/);
        assert.deepEqual(plain(await b.setServerAccessKey(key)),{configured:true});
        assert.deepEqual(plain(await b.getServerAccessKeyStatus()),{configured:true},'status says only whether a key is saved');
        assert.ok((await b.bootstrap(true)).token);
        const probe=await b.testConnection(`http://127.0.0.1:${s.port}`);assert.equal(probe.ok,true,probe.error);
        const cold=make();assert.ok((await cold.bootstrap()).token,'a fresh plugin load reads the saved key');
        const keyed=sent.filter(x=>x.key);
        assert.ok(keyed.length>=2&&keyed.every(x=>x.key===key&&/\/bootstrap$/.test(x.url)),'the key travels on /bootstrap only');
        assert.ok(!Object.values(b).some(v=>v===key),'the bridge never exposes the key');
        await b.setServerAccessKey('');
        assert.deepEqual(plain(await b.getServerAccessKeyStatus()),{configured:false});
        await assert.rejects(()=>b.bootstrap(true),/remote_access_key_required|403/,'a cleared key no longer connects');
      }finally{for(const bridge of bridges)await bridge.dispose().catch(()=>{});await s.app.close();}
    }finally{t.close();}
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
