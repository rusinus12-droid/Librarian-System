'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
function fixture(file,certified=false,legacy=false){
 let url='http://127.0.0.1:47630',hold=null,fail=false,nextUrlRead=null,fault=null;
 const identity=certified?{dataInstanceId:'A'.repeat(32),dataIdentityContract:'memory-suite.physical-data-identity.v1',resetEpochs:{hayaku:0}}:{};
 const caps=Object.fromEntries(['kv.v1','keys.v1','revision.v1','digest.v1','idempotency.v1','tombstone.v1','readback.v1','namespace-integrity.v1'].map(k=>[k,true]));
 if(certified)caps['data-instance-binding.v1']=true;
 const host={async getArgument(k){const value=k==='memory_suite_server_mode'?'server_only':k==='memory_suite_server_url'?url:'';if(k==='memory_suite_server_url'&&nextUrlRead){const h=nextUrlRead;nextUrlRead=null;h.entered.resolve();await h.release.promise;}return value;},async setArgument(k,v){if(k==='memory_suite_server_url')url=v;return true;},async nativeFetch(target){
  const route=new URL(target).pathname;
  if(fault){nextUrlRead=fault;fault=null;throw new Error('network failure synthetic');}
  if(fail)throw new Error('network failure synthetic');
  if(route==='/v1/integrity'&&hold){const h=hold;hold=null;h.entered.resolve();await h.release.promise;if(h.error)throw h.error;}
  const payload=route==='/bootstrap'?{ok:true,schema:'memory-suite.storage.bootstrap.v1',token:'synthetic-only',url,version:'fixture',protocol:{major:1},namespaces:['hayaku'],capabilities:caps,...identity}:{ok:true,...identity,result:{ok:true,result:'ok',records:0}};
  return {ok:true,status:200,text:async()=>JSON.stringify(payload)};
 }};
 const context=vm.createContext({risuai:host,console,URL,AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
 vm.runInContext(fs.readFileSync(path.join(process.env.SDK_TEST_ROOT || path.join(__dirname,'../sdk'),file),'utf8').replace(legacy ? 'mountConnectionPanel: scopedMountConnectionPanel,' : '__unused__', 'mountConnectionPanel,')+'\nglobalThis.make=createMemorySuiteStorageBridge;',context);
 const bridge=context.make({namespace:'hayaku',scopeRouting:false,autoMigratePlugin:false,autoMigrateLocal:false,startupDiagnostics:false,managementButton:false});
 return {bridge,url,holdCatch(){return fault={entered:deferred(),release:deferred()};},hold(){return hold={entered:deferred(),release:deferred()};},fail(){fail=true;}};
}
const makeElement = (tag = 'div') => {
  const element = {
    tagName: String(tag).toUpperCase(),
    innerHTML: '', textContent: '', disabled: false, hidden: false, className: '',
    style: {}, dataset: {}, children: [], attributes: {}, value: '', checked: false, isConnected: true,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    classList: {
      _set: new Set(),
      add(...names) { names.forEach(name => this._set.add(name)); },
      remove(...names) { names.forEach(name => this._set.delete(name)); },
      toggle(name, force) { const on = force === undefined ? !this._set.has(name) : !!force; if (on) this._set.add(name); else this._set.delete(name); return on; },
      contains(name) { return this._set.has(name); }
    },
    appendChild(child) { this.children.push(child); return child; },
    remove() {}, focus() {}, select() {}, closest() { return null },
    querySelector() { return null }, querySelectorAll() { return []; },
    listeners: {}, addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, removeEventListener() {}, dispatch(name) { for (const fn of this.listeners[name] || []) fn(); }
  };
  return element;
};

const makePanelDom = () => {
  const nodesById = new Map();
  const nodesByAttr = new Map();
  const radios = [];

  const container = makeElement('div');
  Object.defineProperty(container, 'innerHTML', {
    get() { return container._html || ''; },
    set(markup) {
      container._html = String(markup);
      nodesById.clear(); nodesByAttr.clear(); radios.length = 0;
      for (const match of String(markup).matchAll(/id="([^"]+)"/g)) nodesById.set(match[1], makeElement('div'));
      for (const match of String(markup).matchAll(/(data-[a-z-]+)/g)) if (!nodesByAttr.has(match[1])) nodesByAttr.set(match[1], makeElement('div'));
      // Preserve actual initial aria attributes; null would conceal range ABA races.
      for (const match of String(markup).matchAll(/<[^>]+(data-scope-(?:global|perchat))[^>]+aria-pressed="([^"]+)"[^>]*>/g)) nodesByAttr.get(match[1])?.setAttribute('aria-pressed', match[2]);
      for (const value of ['plugin_only', 'mirror', 'server_only']) {
        if (String(markup).includes(`value="${value}"`)) radios.push(Object.assign(makeElement('input'), { value, checked: false }));
      }
    }
  });

  // A selector the markup does not provide must not masquerade as a benign null: several call sites
  // guard with `if (node)` while others dereference immediately, so a silent null would fail far from
  // the real cause. This marker throws at first use and names the selector.
  const missing = selector => new Proxy({}, {
    get(_, property) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') return () => `MISSING(${selector})`;
      throw new Error(`panel_selector_missing:${selector}`);
    },
    set() { throw new Error(`panel_selector_missing:${selector}`); }
  });

  const query = selector => {
    const sel = String(selector);
    for (const [attribute, element] of nodesByAttr) if (sel === `[${attribute}]`) return element;
    // `input[name="…-mode"][value="…"]` — the panel restores the checked radio on mount.
    const radioMatch = sel.match(/^input\[name="[^"]*-mode"\]\[value="([^"]+)"\]$/);
    if (radioMatch) {
      const found = radios.find(radio => radio.value === radioMatch[1]);
      return found || missing(sel);
    }
    if (sel.startsWith('input[')) {
      // A bare mode query such as `input[name$="-mode"]:checked`.
      // Imported mirror settings intentionally have no checked endpoint. This
      // recognized state selector may return null; absent control hooks still throw.
      if (/:checked/.test(sel)) return radios.find(radio => radio.checked) || null;
      return radios[0] || missing(sel);
    }
    const idMatch = sel.match(/^#(.+)$/);
    if (idMatch) {
      if (nodesById.has(idMatch[1])) return nodesById.get(idMatch[1]);
      const suffix = idMatch[1].replace(/^[^-]+-/, '');
      for (const [id, element] of nodesById) if (id.endsWith(suffix)) return element;
      return missing(sel);
    }
    return missing(sel);
  };

  const queryAll = selector => {
    const sel = String(selector);
    if (sel.includes('-mode')) return /:checked/.test(sel) ? radios.filter(radio => radio.checked) : radios;
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const attribute = sel.slice(1, -1);
      return nodesByAttr.has(attribute) ? [nodesByAttr.get(attribute)] : [];
    }
    return [];
  };

  const root = makeElement('section');
  root.querySelector = query;
  root.querySelectorAll = queryAll;

  container.querySelector = selector => {
    const sel = String(selector);
    // The panel asks the container for its own root id; every other lookup happens inside that root.
    if (!sel.startsWith('[')) return root;
    return query(sel);
  };
  container.querySelectorAll = queryAll;

  const byAttr = attribute => {
    if (!nodesByAttr.has(attribute)) nodesByAttr.set(attribute, makeElement('div'));
    return nodesByAttr.get(attribute);
  };
  return { container, root, query, queryAll, byAttr, radios };
};


for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 for(const change of ['new-probe','bootstrap','dispose','close','url-input','mode-input','server-url'])test(file+': mounted probe cannot overwrite '+change,async()=>{
  const f=fixture(file),b=f.bridge,dom=makePanelDom();try{
   await b.bootstrap();await b.mountConnectionPanel(dom.container);dom.byAttr('data-url').value=f.url;
   const h=f.hold(),pending=dom.byAttr('data-test').onclick();await h.entered.promise;
   if(change==='new-probe')await dom.byAttr('data-test').onclick();
   if(change==='bootstrap')await b.bootstrap(true);
   if(change==='dispose')await b.dispose();
   if(change==='close')dom.root.isConnected=false;
   if(change==='url-input')dom.byAttr('data-url').value='http://localhost:47630';
   if(change==='mode-input')for(const r of dom.radios)r.checked=r.value==='server_only';
   if(change==='server-url')await b.setServerUrl('http://localhost:47630');
   const before=dom.byAttr('data-status').textContent;
   h.error=new Error('network failure synthetic');h.release.resolve();await pending;
   assert.equal(dom.byAttr('data-status').textContent,before,'obsolete callback must not replace newer selection/connection display');
  }finally{await b.dispose();}
 });
 test(file+': mounted current failure remains visible',async()=>{const f=fixture(file),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();await b.mountConnectionPanel(dom.container);dom.byAttr('data-url').value=f.url;f.fail();await dom.byAttr('data-test').onclick();assert.match(dom.byAttr('data-status').textContent,/연결 실패/);}finally{await b.dispose();}});
}

for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js']){
 for(const successful of [true,false])for(const alternate of [true,false])test(`${file}: older ${successful?'success':'failure'} at ${alternate?'alternate':'configured'} URL preserves newer test`,async()=>{
  const f=fixture(file),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();await b.mountConnectionPanel(dom.container);dom.byAttr('data-url').value=alternate?'http://localhost:47630':f.url;
   const h=f.hold(),old=dom.byAttr('data-test').onclick();await h.entered.promise;await dom.byAttr('data-test').onclick();const displayed=dom.byAttr('data-status').textContent;assert.match(displayed,/연결됨/);
   if(!successful)h.error=new Error('synthetic late failure');h.release.resolve();await old;assert.equal(dom.byAttr('data-status').textContent,displayed);
  }finally{await b.dispose();}
 });
 for(const event of ['input','change'])test(file+': ABA selection event cancels publication '+event,async()=>{const f=fixture(file),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();await b.mountConnectionPanel(dom.container);dom.byAttr('data-url').value=f.url;const h=f.hold(),pending=dom.byAttr('data-test').onclick();await h.entered.promise;dom.root.dispatch(event);const before=dom.byAttr('data-status').textContent;h.release.resolve();await pending;assert.equal(dom.byAttr('data-status').textContent,before);}finally{await b.dispose();}});
 for(const change of ['new-test','bootstrap','close','dispose','url','mode','scope','message'])test(file+': delayed Compute cannot overwrite '+change,async()=>{
  const f=fixture(file),b=f.bridge,dom=makePanelDom(),hold={entered:deferred(),release:deferred()};let first=true;
  const computeBridge={async probe(){if(first){first=false;hold.entered.resolve();await hold.release.promise;}return {ok:true,operationCount:3};}};
  try{await b.bootstrap();await b.mountConnectionPanel(dom.container,{computeBridge});for(const r of dom.radios)r.checked=r.value==='server_only';dom.radios.find(r=>r.checked).dispatch('change');dom.root.dispatch('change');assert.equal(dom.byAttr('data-test').disabled,false);dom.byAttr('data-url').value=f.url;
   const pending=dom.byAttr('data-test').onclick();await hold.entered.promise;
   if(change==='new-test')await dom.byAttr('data-test').onclick();if(change==='bootstrap')await b.bootstrap(true);if(change==='close')dom.root.isConnected=false;if(change==='dispose')await b.dispose();if(change==='url')dom.byAttr('data-url').value='http://localhost:47630';if(change==='mode')for(const r of dom.radios)r.checked=r.value==='plugin_only';if(change==='scope')dom.byAttr('data-scope-global').onclick();if(change==='message')await dom.byAttr('data-apply').onclick();
   const before=dom.byAttr('data-status').textContent;hold.release.resolve();await pending;assert.equal(dom.byAttr('data-status').textContent,before);
  }finally{await b.dispose();}
 });
 if(!process.env.SDK_TEST_SKIP_LEGACY)test(file+': legacy automatic probe cannot overwrite newer manual probe',async()=>{
  const f=fixture(file,false,true),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();const h=f.hold();await b.mountConnectionPanel(dom.container);await h.entered.promise;dom.byAttr('data-mscx-url').value=f.url;await dom.byAttr('data-mscx-test').onclick();assert.equal(dom.byAttr('data-mscx-state-text').textContent,'서버 연결됨');h.error=new Error('old network failure');h.release.resolve();await new Promise(r=>setImmediate(r));assert.equal(dom.byAttr('data-mscx-state-text').textContent,'서버 연결됨');}finally{await b.dispose();}
 });
}
for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])test(file+': alternate URL success cannot relabel newer bootstrap',async()=>{
 const f=fixture(file),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();await b.mountConnectionPanel(dom.container);dom.byAttr('data-url').value='http://localhost:47630';const h=f.hold(),pending=dom.byAttr('data-test').onclick();await h.entered.promise;await b.bootstrap(true);const before=dom.byAttr('data-status').textContent;h.release.resolve();await pending;assert.equal(dom.byAttr('data-status').textContent,before);}finally{await b.dispose();}
});
if(!process.env.SDK_TEST_SKIP_LEGACY)for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])for(const change of ['new-probe','bootstrap','close','dispose','url-input','mode-input'])test(file+': legacy manual callback ignores '+change,async()=>{
 const f=fixture(file,false,true),b=f.bridge,dom=makePanelDom();try{await b.bootstrap();await b.mountConnectionPanel(dom.container);await new Promise(r=>setImmediate(r));dom.byAttr('data-mscx-url').value=f.url;const h=f.hold(),pending=dom.byAttr('data-mscx-test').onclick();await h.entered.promise;
 if(change==='new-probe')await dom.byAttr('data-mscx-test').onclick();if(change==='bootstrap')await b.bootstrap(true);if(change==='close')dom.root.isConnected=false;if(change==='dispose')await b.dispose();if(change==='url-input')dom.byAttr('data-mscx-url').value='http://localhost:47630';if(change==='mode-input')for(const r of dom.radios)r.checked=r.value==='plugin_only';
 const before=[dom.byAttr('data-mscx-message').textContent,dom.byAttr('data-mscx-state-text').textContent];h.error=new Error('late synthetic failure');h.release.resolve();await pending;assert.deepEqual([dom.byAttr('data-mscx-message').textContent,dom.byAttr('data-mscx-state-text').textContent],before);
 }finally{await b.dispose();}
});

for(const file of ['MemorySuiteStorageClient.source.js','MemorySuiteStorageClient.libra.source.js'])for(const phase of ['storage','compute'])for(const start of ['scope','global'])for(const action of ['switch','aba','same'])test(`${file}: ${phase} pending range ${start}/${action}`,async()=>{
 const f=fixture(file),b=f.bridge,dom=makePanelDom(),held={entered:deferred(),release:deferred()};
 const computeBridge={async probe(){held.entered.resolve();await held.release.promise;return {ok:true,operationCount:3};}};
 try{await b.bootstrap();await b.mountConnectionPanel(dom.container,phase==='compute'?{computeBridge}:{});if(phase==='compute'){for(const r of dom.radios)r.checked=r.value==='server_only';dom.radios.find(r=>r.checked).dispatch('change');dom.root.dispatch('change');assert.equal(dom.byAttr('data-test').disabled,false);}dom.byAttr('data-url').value=f.url;
  assert.equal(dom.byAttr('data-scope-global').getAttribute('aria-pressed'),'false');assert.equal(dom.byAttr('data-scope-perchat').getAttribute('aria-pressed'),'true');
  const original=dom.byAttr(start==='scope'?'data-scope-perchat':'data-scope-global'),other=dom.byAttr(start==='scope'?'data-scope-global':'data-scope-perchat');original.onclick();
  const h=phase==='storage'?f.hold():held;const pending=dom.byAttr('data-test').onclick();await h.entered.promise;
  if(action==='same')original.onclick();else{other.onclick();if(action==='aba')original.onclick();}
  const before=dom.byAttr('data-status').textContent;h.release.resolve();await pending;
  if(action==='same')assert.match(dom.byAttr('data-status').textContent,/연결됨/,'same range is still a current attempt');else assert.equal(dom.byAttr('data-status').textContent,before,'range changes fence old display even when range returns to its original value');
 }finally{await b.dispose();}
});
