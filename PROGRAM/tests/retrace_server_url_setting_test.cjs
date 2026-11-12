'use strict';
// RE:TRACE server address field. pluginStorage is shared, so the LIBRA, HAYAKU and Flashback peers follow
// the address each plugin saved; RE:TRACE writes only its manager address and the LIA peer, shows the
// others, refuses a remote address, rolls back a partial failure and keeps the address on cancel.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../plugins/RETRACE.js'),'utf8');
const a=source.indexOf('  const renderServerControl ='),b=source.indexOf('  const renderShell =',a);
assert.ok(a>0&&b>a,'server control section exists');
const shell=source.slice(source.indexOf('root.innerHTML = "<style>'));
assert.match(shell,/data-server-view=\\"connection\\"><div class=\\"stack\\">\\n {8}<div class=\\"card\\"><div class=\\"card__head\\"><div><h2 class=\\"card__title\\">서버 주소<\/h2>/,'the address card leads the connection page');
assert.match(shell,/<input class=\\"input\\" id=\\"retraceServerUrl\\" type=\\"url\\"/);
assert.match(shell,/data-server-control=\\"url-save\\">주소 저장<\/button>/);
assert.match(shell,/<input class=\\"input\\" id=\\"retraceServerAccessKey\\" type=\\"password\\"/,'the access key field is a password field');
assert.match(source,/root\.querySelector\('#openOwnerStorage'\)[^\n]*\n\s*void fillRetraceServerUrl\(root\);/,'the saved address is shown when the page is built');

const allowed=['127.0.0.1','localhost','[::1]','host.docker.internal'];
const makeBridge=(name,state)=>({name,url:'http://127.0.0.1:47630',key:'',
  async setServerAccessKey(value){
    if(value&&!/^[A-Za-z0-9_-]{32,256}$/.test(value))throw Object.assign(Error('memory_suite_access_key_invalid'),{code:'MEMORY_SUITE_ACCESS_KEY_INVALID'});
    this.key=value;state.keyWrites.push(name);return {configured:!!value};
  },
  async getServerAccessKeyStatus(){return {configured:!!this.key};},
  async setServerUrl(value){
    if(state.fail===name)throw Object.assign(Error('argument_write_rejected'),{code:'MEMORY_SUITE_ARGUMENT_PERSISTENCE_UNAVAILABLE'});
    const parsed=new URL(value);if(parsed.protocol!=='http:'||!allowed.includes(parsed.hostname))throw Object.assign(Error('invalid_memory_suite_server_url:server_url_must_be_loopback_http'),{code:'MEMORY_SUITE_INVALID_SERVER_URL'});
    this.url=parsed.origin;state.writes.push([name,this.url]);return {url:this.url};
  }});
const fixture=()=>{
  const state={writes:[],keyWrites:[],fail:'',accept:true,probe:{ok:true}};
  const nodes={'#serverControlResult':{textContent:'',dataset:{}},'#retraceServerUrl':{value:''},'#retraceServerUrlPeers':{innerHTML:''},'#retraceServerAccessKey':{value:''},'#retraceServerAccessKeyStatus':{textContent:''}};
  const root={querySelector:id=>nodes[id]||null,querySelectorAll:()=>[],ownerDocument:{activeElement:null}};
  const Runtime={busy:false,serverControl:{},root,visible:true};
  const manager=Object.assign(makeBridge('retrace',state),{
    getConnectionSettings:async()=>({url:manager.url,mode:'plugin_only',scopeId:'fixture'}),
    testConnection:async()=>state.probe,managerConnection:async()=>({resetEpochs:{}}),
    serverBinding:()=>({generation:1,dataInstanceId:'fixture',current:true}),
    managerControl:async action=>action==='status'?{version:'fixture',stores:{stores:{}},clients:[]}:[]});
  const peers=Object.fromEntries(['flashback','hayaku','libra','lia'].map(ns=>[ns,Object.assign(makeBridge(ns,state),{getConnectionSettings:async()=>({url:peers[ns].url})})]));
  const deps={openRetraceJob:()=>{},finishRetraceJob:()=>{},updateRetraceJob:()=>{},Runtime,escapeHtml:v=>String(v??''),
    scopeManagerArray:v=>Array.isArray(v)?v:[],scopeManagerFormatTime:String,scopeManagerFormatBytes:String,MEMORY_SUITE_NAMESPACE_LABELS:{libra:'LIBRA',hayaku:'HAYAKU',flashback:'Flashback'},
    setBusy:v=>{Runtime.busy=v;},retraceConfirm:async()=>state.accept,text:v=>String(v??''),
    MemorySuiteStorageBridge:manager,MemorySuitePeerServerBridges:peers,
    getCurrentContext:async()=>({}),contextIdentity:()=>({characterId:'c',chatId:'h'}),liveApi:()=>({getCharacter:async()=>({id:'c'}),getChat:async()=>({id:'h'})}),identityValue:v=>String(v??'')};
  const api=new Function(...Object.keys(deps),source.slice(a,b)+'\nreturn {handleServerControl,fillRetraceServerUrl};')(...Object.values(deps));
  const click=()=>api.handleServerControl({target:{closest:()=>({disabled:false,getAttribute:()=>'url-save'})}});
  const urls=()=>[manager,peers.lia].map(bridge=>bridge.url);
  const followed=()=>[peers.libra,peers.hayaku,peers.flashback].map(bridge=>bridge.url);
  return {state,nodes,root,api,click,urls,followed,peers,manager};
};

(async()=>{
  const results=[];
  { // Shown on build, saved to RE:TRACE and the LIA peer, then verified; the other plugins are only shown.
    const f=fixture();await f.api.fillRetraceServerUrl(f.root);
    assert.equal(f.nodes['#retraceServerUrl'].value,'http://127.0.0.1:47630');
    f.nodes['#retraceServerUrl'].value='http://127.0.0.1:48001';await f.click();
    assert.deepEqual(f.urls(),Array(2).fill('http://127.0.0.1:48001'),'RE:TRACE and the LIA peer use the new address');
    assert.deepEqual(f.state.writes.map(row=>row[0]),['retrace','lia'],'other plugins\x27 saved addresses are never written');
    assert.deepEqual(f.followed(),Array(3).fill('http://127.0.0.1:47630'));
    assert.match(f.nodes['#retraceServerUrlPeers'].innerHTML,/LIBRA<\/b><span class="role">http:\/\/127\.0\.0\.1:47630<\/span><small>RE:TRACE와 다른 주소/);
    assert.match(f.nodes['#retraceServerUrlPeers'].innerHTML,/주소가 다른 플러그인이 있습니다/);
    assert.equal(f.nodes['#retraceServerUrl'].value,'http://127.0.0.1:48001');
    assert.match(f.nodes['#serverControlResult'].textContent,/서버 주소 저장 완료: http:\/\/127\.0\.0\.1:48001 · 연결 확인됨/);
    results.push('saves RE:TRACE and LIA, shows the other plugins');
  }
  { // Docker host name is accepted like the plugins' own settings.
    const f=fixture();f.nodes['#retraceServerUrl'].value='http://host.docker.internal:47640';await f.click();
    assert.deepEqual(f.urls(),Array(2).fill('http://host.docker.internal:47640'));results.push('host.docker.internal accepted');
  }
  { // A remote address is refused before any connection changes.
    const f=fixture();f.nodes['#retraceServerUrl'].value='http://192.168.0.10:47630';await f.click();
    assert.deepEqual(f.urls(),Array(2).fill('http://127.0.0.1:47630'));assert.equal(f.state.writes.length,0);
    assert.match(f.nodes['#serverControlResult'].textContent,/허용되지 않는 주소입니다/);results.push('remote address refused, nothing changed');
  }
  { // A failure part-way returns the saved connections to the previous address.
    const f=fixture();f.state.fail='lia';f.nodes['#retraceServerUrl'].value='http://127.0.0.1:48001';await f.click();
    assert.deepEqual(f.urls(),Array(2).fill('http://127.0.0.1:47630'),'no connection is left on the new address');
    assert.match(f.nodes['#serverControlResult'].textContent,/저장했던 연결은 이전 주소로 되돌렸습니다/);results.push('partial failure rolled back');
  }
  { // Cancel and empty input change nothing.
    const f=fixture();f.state.accept=false;f.nodes['#retraceServerUrl'].value='http://127.0.0.1:48001';await f.click();
    assert.equal(f.state.writes.length,0);assert.match(f.nodes['#serverControlResult'].textContent,/취소했습니다/);
    f.state.accept=true;f.nodes['#retraceServerUrl'].value='  ';await f.click();
    assert.equal(f.state.writes.length,0);assert.match(f.nodes['#serverControlResult'].textContent,/서버 주소를 입력하세요/);
    results.push('cancel and empty input keep the address');
  }
  { // Saved but unreachable is reported as such, not as success.
    const f=fixture();f.state.probe={ok:false,error:'connect ECONNREFUSED'};f.nodes['#retraceServerUrl'].value='http://127.0.0.1:48001';await f.click();
    assert.deepEqual(f.urls(),Array(2).fill('http://127.0.0.1:48001'));
    assert.match(f.nodes['#serverControlResult'].textContent,/저장했지만 연결하지 못했습니다[\s\S]*ECONNREFUSED/);results.push('unreachable server reported');
  }
  { // A focused field is not overwritten while the user types.
    const f=fixture();f.nodes['#retraceServerUrl'].value='http://127.0.0.1:4';f.root.ownerDocument.activeElement=f.nodes['#retraceServerUrl'];
    await f.api.fillRetraceServerUrl(f.root);assert.equal(f.nodes['#retraceServerUrl'].value,'http://127.0.0.1:4');results.push('typing is not overwritten');
  }
  { // A typed access key goes to RE:TRACE and LIA before the address, is cleared from the field and never shown.
    const f=fixture();const key='k'.repeat(43);
    f.nodes['#retraceServerUrl'].value='http://127.0.0.1:47630';f.nodes['#retraceServerAccessKey'].value=key;await f.click();
    assert.deepEqual(f.state.keyWrites,['retrace','lia'],'the key is saved only to RE:TRACE and LIA');
    assert.deepEqual([f.manager.key,f.peers.lia.key,f.peers.libra.key],[key,key,'']);
    assert.equal(f.nodes['#retraceServerAccessKey'].value,'','the field is cleared after saving');
    assert.match(f.nodes['#retraceServerAccessKeyStatus'].textContent,/접근 키 저장됨/);
    assert.doesNotMatch(JSON.stringify(f.nodes),new RegExp(key),'the key is not written back to the page');
    results.push('access key saved to RE:TRACE and LIA');
  }
  { // A malformed key stops before any address changes; an empty field keeps the saved key.
    const f=fixture();f.nodes['#retraceServerUrl'].value='http://127.0.0.1:48001';f.nodes['#retraceServerAccessKey'].value='short';await f.click();
    assert.equal(f.state.writes.length,0);assert.match(f.nodes['#serverControlResult'].textContent,/접근 키 형식이 올바르지 않습니다/);
    f.nodes['#retraceServerAccessKey'].value='';await f.click();assert.equal(f.state.keyWrites.length,0);
    results.push('bad key refused, empty field keeps the key');
  }
  { // A server that wants a key says so.
    const f=fixture();f.state.probe={ok:false,error:'HTTP 403 remote_access_key_required'};f.nodes['#retraceServerUrl'].value='http://127.0.0.1:47630';await f.click();
    assert.match(f.nodes['#serverControlResult'].textContent,/접근 키를 요구합니다/);results.push('key-required server explained');
  }
  console.log('retrace_server_url_setting_test: PASS ('+results.join('; ')+')');
})().catch(e=>{console.error(e);process.exitCode=1;});
